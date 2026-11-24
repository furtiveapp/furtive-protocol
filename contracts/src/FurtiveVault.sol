// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InternalLeanIMT, LeanIMTData} from "lean-imt/InternalLeanIMT.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";
import {ITransactVerifier} from "./interfaces/ITransactVerifier.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

/// @dev Uniswap v4 PoolManager exposes its storage for reading pool prices.
interface IPoolStateReader {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * @title FurtiveVault
 * @notice A private balance for each user, held as notes that only the user's
 *         key can spend. Users deposit, trade through any DEX, and withdraw,
 *         and nobody watching the chain can tell which trades are whose.
 *
 * Nobody controls this contract:
 *  - There is no owner, admin, guardian or upgrade path. Every setting is fixed
 *    at deployment and can never change.
 *  - Funds leave only with a valid proof made from the note owner's secret key.
 *  - No function lets anyone pause, freeze, redirect or take user funds.
 *  - The only money that goes to Furtive is the swap fee, fixed at deployment
 *    and capped at 1%. Anyone can send collected fees to the fixed treasury.
 *
 * Notes. commitment = Poseidon(npk, asset, amount), where npk is a one-time key
 * only the owner can open. Deposits and swap proceeds are turned into notes by
 * this contract from the amount it actually received, so no note can ever be
 * worth more than the funds behind it.
 *
 * Launch limits. Only the base assets named at deployment can be deposited
 * directly, up to per-deposit and total limits that double every
 * CAP_PERIOD and disappear after MAX_DOUBLINGS. The schedule is fixed in the
 * code: nobody can raise, lower or switch off a limit. Limits never apply to
 * swaps or withdrawals.
 *
 * Orders. A limit order or stop-loss is placed with a normal proof: the amount
 * leaves the private balance into an order slot here, and only a fingerprint of
 * its terms is stored. Anyone holding the terms can later fill it, and the vault
 * itself checks that the trade meets them: the token bought, the least it may
 * return, the trigger price read from the Uniswap v4 pool, and the expiry. What
 * comes back becomes a new note under the owner's key. Before expiry only the
 * owner (who alone knows the cancel key) can cancel; after expiry anyone holding
 * the terms can, and a cancelled order can only return to the owner as a note.
 *
 * Invariant: for every asset, balance >= held[asset] + feesOwed[asset] + escrowed[asset].
 */
contract FurtiveVault {
    using InternalLeanIMT for LeanIMTData;

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant MAX_AMOUNT = 2 ** 248;
    uint256 internal constant MAX_LEAVES = 2 ** 32;
    uint256 public constant ROOT_HISTORY = 64;
    uint256 public constant MAX_SWAP_FEE_BPS = 100;
    uint256 public constant CAP_PERIOD = 14 days;
    uint256 public constant MAX_DOUBLINGS = 8;
    address internal constant NATIVE = address(0);
    /// @notice Put in ExtData.adapter to place an order instead of swapping.
    address public constant ORDER_BOOK = address(uint160(uint256(keccak256("furtive.orders"))));
    uint256 internal constant POOLS_SLOT = 6; // Uniswap v4 PoolManager: mapping(PoolId => Pool.State)

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    /// @notice The public side of a transaction proof.
    struct Transaction {
        uint256 root;
        uint256 treeDepth;
        address asset;
        uint256 publicAmount;
        uint256[2] nullifiers;
        uint256[2] commitments;
    }

    /// @notice Everything the proof binds through extDataHash.
    /// For a withdrawal: adapter is zero and recipient receives the funds.
    /// For a swap: adapter sells the funds for assetOut, and everything that
    /// comes back becomes a new note under outNpk.
    struct ExtData {
        address recipient;
        address relayer;
        uint256 relayerFee;
        address adapter;
        address assetOut;
        uint256 minOut;
        uint256 outNpk;
        uint256 deadline;
        bytes adapterData;
        bytes[2] encryptedOutputs;
        bytes encryptedSwapNote;
    }

    /// @notice The terms of an order. Only keccak256(abi.encode(terms)) is stored
    ///         when it is placed, so the terms stay unseen until it is filled.
    struct OrderTerms {
        address assetOut; // what to buy
        uint256 minOut; // the least the whole order may return
        uint256 outNpk; // proceeds become a note under this key
        bytes32 outNoteHash; // keccak256 of the sealed note published on fill
        uint256 cancelNpk; // a cancel returns the funds as a note under this key
        bytes32 cancelNoteHash; // keccak256 of the sealed note published on cancel
        bytes32 cancelKeyHash; // keccak256(abi.encode(cancelKey)), known only to the owner
        uint64 expiry; // no fills after this time; after it anyone may cancel
        uint8 trigger; // 0 none; 1 fill only when the pool price is at or below; 2 at or above
        bytes32 poolId; // the Uniswap v4 pool whose price is the trigger
        uint160 triggerSqrtPrice; // the trigger, as that pool's sqrtPriceX96
        uint256 fillerFee; // the most the filler may take, in the order's asset
        uint256 salt; // makes every fingerprint unique
    }

    struct Order {
        address asset;
        uint256 amount;
        uint256 termsHash;
    }

    struct BaseAsset {
        address asset;
        uint256 perDeposit;
        uint256 total;
    }

    ITransactVerifier public immutable verifier;
    IPoolStateReader public immutable poolManager;
    address public immutable treasury;
    uint256 public immutable swapFeeBps;
    uint256 public immutable launchedAt;

    address public immutable baseAssetA;
    uint256 internal immutable perDepositA;
    uint256 internal immutable totalA;
    address public immutable baseAssetB;
    uint256 internal immutable perDepositB;
    uint256 internal immutable totalB;

    LeanIMTData internal tree;
    uint256[ROOT_HISTORY] public roots;
    uint256 public currentRootIndex;

    mapping(uint256 => bool) public nullifierSpent;
    /// @notice Funds that back notes, per asset.
    mapping(address => uint256) public held;
    /// @notice Swap fees waiting for collectFees, per asset. They back no note.
    mapping(address => uint256) public feesOwed;
    /// @notice Funds waiting in open orders, per asset.
    mapping(address => uint256) public escrowed;
    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    uint256 private _lock;
    bool private _awaitingNative;

    event Deposited(address indexed asset, uint256 amount, uint256 commitment, uint256 leafIndex, bytes encryptedNote);
    event NoteCreated(uint256 commitment, uint256 leafIndex, bytes encryptedNote);
    event NoteSpent(uint256 nullifier);
    event Withdrawn(address indexed asset, address indexed recipient, uint256 amount, address relayer, uint256 relayerFee);
    event Swapped(
        address indexed assetIn,
        address indexed assetOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 commitment,
        uint256 leafIndex,
        bytes encryptedNote
    );
    event FeesCollected(address indexed asset, uint256 amount);
    /// @param sealedTerms the terms, encrypted to the owner, so 12 words alone can find and cancel the order
    event OrderPlaced(uint256 indexed id, address indexed asset, uint256 amount, bytes sealedTerms);
    event OrderFilled(uint256 indexed id);
    event OrderCancelled(uint256 indexed id);

    error Reentrancy();
    error ZeroAddress();
    error BadConfig();
    error NotBaseAsset();
    error OverDepositLimit();
    error BadAmount();
    error BadNpk();
    error BadMsgValue();
    error UnknownRoot();
    error NullifierSpent();
    error DuplicateNullifier();
    error ExtDataMismatch();
    error InvalidProof();
    error BadRecipient();
    error BadSwap();
    error Expired();
    error ShortOutput(uint256 got, uint256 wanted);
    error TreeFull();
    error TransferFailed();
    error NativeRefused();
    error NothingToCollect();
    error NoSuchOrder();
    error TermsMismatch();
    error TriggerNotMet();
    error NotCancellable();

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    constructor(
        address verifier_,
        address poolManager_,
        address treasury_,
        uint256 swapFeeBps_,
        BaseAsset memory a,
        BaseAsset memory b
    ) {
        if (verifier_ == address(0) || treasury_ == address(0) || poolManager_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0 || poolManager_.code.length == 0) revert BadConfig();
        if (swapFeeBps_ > MAX_SWAP_FEE_BPS) revert BadConfig();
        if (a.asset == b.asset) revert BadConfig();
        if (a.perDeposit == 0 || a.perDeposit > a.total || b.perDeposit == 0 || b.perDeposit > b.total) revert BadConfig();
        verifier = ITransactVerifier(verifier_);
        poolManager = IPoolStateReader(poolManager_);
        treasury = treasury_;
        swapFeeBps = swapFeeBps_;
        launchedAt = block.timestamp;
        baseAssetA = a.asset;
        perDepositA = a.perDeposit;
        totalA = a.total;
        baseAssetB = b.asset;
        perDepositB = b.perDeposit;
        totalB = b.total;
    }

    /// @notice ETH is accepted only from a swap in progress.
    receive() external payable {
        if (!_awaitingNative) revert NativeRefused();
    }

    // ─────────────────────────────────────────────────────────────── deposits

    /**
     * @notice Put funds into the vault as a new private note.
     * @param asset A base asset (address(0) for native ETH).
     * @param amount The amount to send. For an ERC-20 the note records what
     *        actually arrived.
     * @param npk The note's one-time public key, Poseidon(pk, blinding).
     * @param encryptedNote The note, encrypted to the owner, for recovery.
     */
    function deposit(address asset, uint256 amount, uint256 npk, bytes calldata encryptedNote)
        external
        payable
        nonReentrant
        returns (uint256 commitment, uint256 leafIndex)
    {
        if (amount == 0) revert BadAmount();
        if (npk == 0 || npk >= FIELD) revert BadNpk();
        (uint256 perDeposit, uint256 total) = depositLimits(asset);
        if (amount > perDeposit || held[asset] + amount > total) revert OverDepositLimit();

        uint256 received;
        if (asset == NATIVE) {
            if (msg.value != amount) revert BadMsgValue();
            received = amount;
        } else {
            if (msg.value != 0) revert BadMsgValue();
            uint256 before = IERC20Min(asset).balanceOf(address(this));
            _pull(asset, msg.sender, amount);
            received = IERC20Min(asset).balanceOf(address(this)) - before;
        }
        if (received == 0 || received >= MAX_AMOUNT) revert BadAmount();

        held[asset] += received;
        commitment = _noteHash(npk, asset, received);
        leafIndex = _insert(commitment);
        _pushRoot();
        emit Deposited(asset, received, commitment, leafIndex, encryptedNote);
    }

    /**
     * @notice The deposit limits for `asset` right now. Fixed in code: they double
     *         every CAP_PERIOD from launch and are gone after MAX_DOUBLINGS.
     */
    function depositLimits(address asset) public view returns (uint256 perDeposit, uint256 total) {
        if (asset == baseAssetA) (perDeposit, total) = (perDepositA, totalA);
        else if (asset == baseAssetB) (perDeposit, total) = (perDepositB, totalB);
        else revert NotBaseAsset();
        uint256 doublings = (block.timestamp - launchedAt) / CAP_PERIOD;
        if (doublings >= MAX_DOUBLINGS) return (type(uint256).max, type(uint256).max);
        return (perDeposit << doublings, total << doublings);
    }

    // ─────────────────────────────────────────────────────────── transactions

    /**
     * @notice Spend notes with a proof: move value privately, withdraw it, or
     *         swap it. Anyone may submit; only the proof decides what happens.
     */
    function transact(Proof calldata proof, Transaction calldata t, ExtData calldata ext) external nonReentrant {
        if (!isKnownRoot(t.root)) revert UnknownRoot();
        if (t.nullifiers[0] == t.nullifiers[1]) revert DuplicateNullifier();
        if (t.publicAmount >= MAX_AMOUNT) revert BadAmount();
        _verify(proof, t, extDataHash(ext));

        for (uint256 i = 0; i < 2; i++) {
            if (nullifierSpent[t.nullifiers[i]]) revert NullifierSpent();
            nullifierSpent[t.nullifiers[i]] = true;
            emit NoteSpent(t.nullifiers[i]);
        }
        for (uint256 i = 0; i < 2; i++) {
            uint256 idx = _insert(t.commitments[i]);
            emit NoteCreated(t.commitments[i], idx, ext.encryptedOutputs[i]);
        }

        if (t.publicAmount == 0) {
            // A private move between notes: nothing leaves, so nothing else may be set.
            if (ext.adapter != address(0) || ext.relayerFee != 0 || ext.recipient != address(0)) revert BadRecipient();
            _pushRoot();
            return;
        }

        held[t.asset] -= t.publicAmount;
        if (ext.relayerFee > t.publicAmount) revert BadAmount();

        if (ext.adapter == address(0)) {
            _withdraw(t, ext);
            _pushRoot();
        } else if (ext.adapter == ORDER_BOOK) {
            _placeOrder(t, ext);
        } else {
            _swap(t, ext);
        }
    }

    /// @dev adapterData = abi.encode(termsHash, sealedTerms).
    function _placeOrder(Transaction calldata t, ExtData calldata ext) private {
        if (ext.recipient != address(0)) revert BadRecipient();
        if (ext.relayerFee != 0) _push(t.asset, ext.relayer, ext.relayerFee);
        uint256 amount = t.publicAmount - ext.relayerFee;
        if (amount == 0) revert BadAmount();
        (uint256 termsHash_, bytes memory sealedTerms) = abi.decode(ext.adapterData, (uint256, bytes));
        if (termsHash_ == 0) revert TermsMismatch();
        uint256 id = nextOrderId++;
        orders[id] = Order(t.asset, amount, termsHash_);
        escrowed[t.asset] += amount;
        _pushRoot();
        emit OrderPlaced(id, t.asset, amount, sealedTerms);
    }

    /**
     * @notice Fill an open order. Anyone holding its terms may call; the vault checks
     *         every term itself, so a filler can only make the trade the owner set.
     * @param encryptedNote the sealed note for the proceeds, fixed by the owner in the terms
     */
    function fillOrder(
        uint256 id,
        OrderTerms calldata terms,
        address adapter,
        bytes calldata adapterData,
        bytes calldata encryptedNote
    ) external nonReentrant {
        Order memory o = orders[id];
        if (o.amount == 0) revert NoSuchOrder();
        if (termsHash(terms) != o.termsHash || keccak256(encryptedNote) != terms.outNoteHash) revert TermsMismatch();
        if (block.timestamp > terms.expiry) revert Expired();
        if (!triggerMet(terms)) revert TriggerNotMet();
        if (terms.assetOut == o.asset || adapter == address(this) || adapter.code.length == 0) revert BadSwap();
        if (terms.outNpk == 0 || terms.outNpk >= FIELD) revert BadNpk();

        delete orders[id];
        escrowed[o.asset] -= o.amount;
        uint256 fee = _fee(o.amount);
        if (fee + terms.fillerFee >= o.amount) revert BadAmount();
        if (fee != 0) feesOwed[o.asset] += fee;
        if (terms.fillerFee != 0) _push(o.asset, msg.sender, terms.fillerFee);
        uint256 amountIn = o.amount - fee - terms.fillerFee;

        uint256 received = _execSwap(o.asset, terms.assetOut, amountIn, terms.minOut, adapter, adapterData);
        held[terms.assetOut] += received;
        uint256 commitment = _noteHash(terms.outNpk, terms.assetOut, received);
        uint256 idx = _insert(commitment);
        _pushRoot();
        emit Swapped(o.asset, terms.assetOut, amountIn, received, fee, commitment, idx, encryptedNote);
        emit OrderFilled(id);
    }

    /**
     * @notice Cancel an open order: its funds return to the owner as a private note.
     *         Before expiry it needs the owner's cancel key; after expiry anyone
     *         holding the terms may return the funds.
     */
    function cancelOrder(uint256 id, OrderTerms calldata terms, bytes32 cancelKey, bytes calldata encryptedNote)
        external
        nonReentrant
    {
        Order memory o = orders[id];
        if (o.amount == 0) revert NoSuchOrder();
        if (termsHash(terms) != o.termsHash || keccak256(encryptedNote) != terms.cancelNoteHash) revert TermsMismatch();
        if (keccak256(abi.encode(cancelKey)) != terms.cancelKeyHash && block.timestamp <= terms.expiry) revert NotCancellable();
        if (terms.cancelNpk == 0 || terms.cancelNpk >= FIELD) revert BadNpk();

        delete orders[id];
        escrowed[o.asset] -= o.amount;
        held[o.asset] += o.amount;
        uint256 commitment = _noteHash(terms.cancelNpk, o.asset, o.amount);
        uint256 idx = _insert(commitment);
        _pushRoot();
        // reported as a deposit back into the private balance, so every wallet finds it the usual way
        emit Deposited(o.asset, o.amount, commitment, idx, encryptedNote);
        emit OrderCancelled(id);
    }

    function _withdraw(Transaction calldata t, ExtData calldata ext) private {
        if (ext.recipient == address(0) || ext.recipient == address(this)) revert BadRecipient();
        if (ext.relayerFee != 0) _push(t.asset, ext.relayer, ext.relayerFee);
        uint256 amount = t.publicAmount - ext.relayerFee;
        _push(t.asset, ext.recipient, amount);
        emit Withdrawn(t.asset, ext.recipient, amount, ext.relayer, ext.relayerFee);
    }

    function _swap(Transaction calldata t, ExtData calldata ext) private {
        if (block.timestamp > ext.deadline) revert Expired();
        if (ext.recipient != address(0)) revert BadRecipient();
        if (ext.assetOut == t.asset || ext.adapter == address(this) || ext.adapter.code.length == 0) revert BadSwap();
        if (ext.outNpk == 0 || ext.outNpk >= FIELD) revert BadNpk();

        uint256 fee = _fee(t.publicAmount);
        if (fee + ext.relayerFee > t.publicAmount) revert BadAmount();
        if (fee != 0) feesOwed[t.asset] += fee;
        if (ext.relayerFee != 0) _push(t.asset, ext.relayer, ext.relayerFee);
        uint256 amountIn = t.publicAmount - fee - ext.relayerFee;
        if (amountIn == 0) revert BadAmount();

        uint256 received = _execSwap(t.asset, ext.assetOut, amountIn, ext.minOut, ext.adapter, ext.adapterData);
        held[ext.assetOut] += received;
        uint256 commitment = _noteHash(ext.outNpk, ext.assetOut, received);
        uint256 idx = _insert(commitment);
        _pushRoot();
        emit Swapped(t.asset, ext.assetOut, amountIn, received, fee, commitment, idx, ext.encryptedSwapNote);
    }

    /// @dev Sells amountIn of assetIn through adapter; returns exactly what arrived.
    function _execSwap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut, address adapter, bytes calldata data)
        private
        returns (uint256 received)
    {
        uint256 before = _balance(assetOut);
        _awaitingNative = assetOut == NATIVE;
        if (assetIn == NATIVE) {
            ISwapAdapter(adapter).swap{value: amountIn}(assetIn, assetOut, amountIn, minOut, data);
        } else {
            _push(assetIn, adapter, amountIn);
            ISwapAdapter(adapter).swap(assetIn, assetOut, amountIn, minOut, data);
        }
        _awaitingNative = false;
        received = _balance(assetOut) - before;
        if (received < minOut || received == 0) revert ShortOutput(received, minOut);
        if (received >= MAX_AMOUNT) revert BadAmount();
    }

    /// @notice Send an asset's collected swap fees to the fixed treasury. Anyone may call.
    function collectFees(address asset) external nonReentrant {
        uint256 amount = feesOwed[asset];
        if (amount == 0) revert NothingToCollect();
        feesOwed[asset] = 0;
        _push(asset, treasury, amount);
        emit FeesCollected(asset, amount);
    }

    // ───────────────────────────────────────────────────────────────── views

    /// @notice The hash a transaction proof commits to for its external data.
    function extDataHash(ExtData calldata ext) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(ext))) % FIELD;
    }

    /// @notice The fingerprint stored for an order's terms.
    function termsHash(OrderTerms calldata terms) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(terms)));
    }

    /// @notice Whether an order's trigger holds right now, read from the pool itself.
    function triggerMet(OrderTerms calldata terms) public view returns (bool) {
        if (terms.trigger == 0) return true;
        uint160 price = uint160(uint256(poolManager.extsload(keccak256(abi.encode(terms.poolId, POOLS_SLOT)))));
        if (price == 0) return false;
        if (terms.trigger == 1) return price <= terms.triggerSqrtPrice;
        if (terms.trigger == 2) return price >= terms.triggerSqrtPrice;
        return false;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        for (uint256 i = 0; i < ROOT_HISTORY; i++) {
            if (roots[i] == root) return true;
        }
        return false;
    }

    function currentRoot() external view returns (uint256) {
        return tree._root();
    }

    function treeSize() external view returns (uint256) {
        return tree.size;
    }

    function treeDepth() external view returns (uint256) {
        return tree.depth;
    }

    // ────────────────────────────────────────────────────────────── internals

    function _verify(Proof calldata proof, Transaction calldata t, uint256 extHash) private view {
        uint256[9] memory pub = [
            t.root,
            t.treeDepth,
            uint256(uint160(t.asset)),
            t.publicAmount,
            extHash,
            t.nullifiers[0],
            t.nullifiers[1],
            t.commitments[0],
            t.commitments[1]
        ];
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert InvalidProof();
    }

    function _fee(uint256 amount) private view returns (uint256) {
        return (amount / 10_000) * swapFeeBps + ((amount % 10_000) * swapFeeBps) / 10_000;
    }

    function _noteHash(uint256 npk, address asset, uint256 amount) private pure returns (uint256) {
        return PoseidonT4.hash([npk, uint256(uint160(asset)), amount]);
    }

    function _insert(uint256 leaf) private returns (uint256 index) {
        index = tree.size;
        if (index >= MAX_LEAVES) revert TreeFull();
        tree._insert(leaf);
    }

    function _pushRoot() private {
        uint256 next = (currentRootIndex + 1) % ROOT_HISTORY;
        roots[next] = tree._root();
        currentRootIndex = next;
    }

    function _balance(address asset) private view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20Min(asset).balanceOf(address(this));
    }

    function _pull(address asset, address from, uint256 amount) private {
        if (asset.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address asset, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (asset == NATIVE) {
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert TransferFailed();
            return;
        }
        if (asset.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
