// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FurtiveVaultTest} from "../FurtiveVault.t.sol";
import {FurtiveVault} from "../../src/FurtiveVault.sol";
import {Groth16Verifier} from "../../src/verifiers/TransactVerifier.sol";
import {UniswapV4Adapter, PoolKey} from "../../src/adapters/UniswapV4Adapter.sol";
import {MockERC20} from "../mocks/Mocks.sol";

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerAdmin {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

/// @dev Adds full-range liquidity to a pool and pays what the PoolManager asks.
contract LiquidityHelper {
    IPoolManagerAdmin immutable pm;

    constructor(address pm_) {
        pm = IPoolManagerAdmin(pm_);
    }

    function add(PoolKey memory key, int256 liquidity) external payable {
        pm.unlock(abi.encode(key, liquidity, int24(-887220), int24(887220)));
    }

    function addRange(PoolKey memory key, int256 liquidity, int24 lower, int24 upper) external payable {
        pm.unlock(abi.encode(key, liquidity, lower, upper));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int256 liquidity, int24 lower, int24 upper) = abi.decode(data, (PoolKey, int256, int24, int24));
        (int256 delta,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        _pay(key.currency0, int128(delta >> 128));
        _pay(key.currency1, int128(delta));
        return "";
    }

    function _pay(address currency, int128 d) private {
        if (d >= 0) return;
        uint256 owed = uint256(uint128(-d));
        pm.sync(currency);
        if (currency == address(0)) {
            pm.settle{value: owed}();
        } else {
            MockERC20(currency).transfer(address(pm), owed);
            pm.settle();
        }
    }

    receive() external payable {}
}

/// @dev Runs against the live Uniswap v4 PoolManager on Robinhood Chain testnet.
///      forge test --match-path test/fork/*
contract UniswapV4ForkTest is FurtiveVaultTest {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 constant PRICE_ONE = 79228162514264337593543950336; // sqrtPriceX96 for a raw 1:1 price

    UniswapV4Adapter v4;
    MockERC20 meme;
    PoolKey ethUsdg;
    PoolKey usdgMeme;

    function _poolManager() internal pure override returns (address) {
        return POOL_MANAGER;
    }

    function setUp() public override {
        vm.createSelectFork("rh_testnet");
        super.setUp();
        v4 = new UniswapV4Adapter(POOL_MANAGER);
        meme = new MockERC20("MEME", 18);

        LiquidityHelper lp = new LiquidityHelper(POOL_MANAGER);
        vm.deal(address(lp), 10_000 ether);
        usdg.mint(address(lp), 1e30);
        meme.mint(address(lp), 1e30);

        ethUsdg = PoolKey(address(0), address(usdg), 3000, 60, address(0));
        (address c0, address c1) = address(usdg) < address(meme) ? (address(usdg), address(meme)) : (address(meme), address(usdg));
        usdgMeme = PoolKey(c0, c1, 3000, 60, address(0));

        IPoolManagerAdmin(POOL_MANAGER).initialize(ethUsdg, PRICE_ONE);
        IPoolManagerAdmin(POOL_MANAGER).initialize(usdgMeme, PRICE_ONE);
        lp.add(ethUsdg, 1_000 ether);
        lp.add(usdgMeme, 1_000 ether);
    }

    function test_private_two_hop_swap_on_uniswap_v4_then_withdraw() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        Note memory proceeds = _note(51, 52, address(meme), 0);

        PoolKey[] memory route = new PoolKey[](2);
        route[0] = ethUsdg;
        route[1] = usdgMeme;
        FurtiveVault.ExtData memory e = _swapExt(address(v4), address(meme), 0.9 ether, proceeds.npk);
        e.adapterData = abi.encode(route);

        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vault.transact(p, t, e);
        _recordOutputs(t);

        uint256 got = vault.held(address(meme));
        assertGt(got, 0.9 ether, "two 0.3% pools on a 1:1 price give a little under 0.997");
        assertEq(meme.balanceOf(address(vault)), got);
        assertEq(meme.balanceOf(address(v4)), 0, "the adapter keeps nothing");
        assertEq(address(v4).balance, 0);
        assertEq(vault.feesOwed(ETH), 0.003 ether);

        proceeds.amount = got;
        proceeds.commitment = _commit(proceeds.npk, address(meme), got);
        leaves.push(proceeds.commitment);
        FurtiveVault.ExtData memory w = _withdrawExt(bob, address(0), 0);
        (p, t) = _prove(_one(proceeds), new Out[](0), address(meme), got, w);
        vault.transact(p, t, w);
        assertEq(meme.balanceOf(bob), got);
    }

    function test_adapter_rejects_a_route_that_does_not_end_in_the_asset() public {
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethUsdg;
        vm.expectRevert(UniswapV4Adapter.BadRoute.selector);
        v4.swap{value: 1 ether}(ETH, address(meme), 1 ether, 0, abi.encode(route));
    }

    function test_adapter_refuses_a_partial_fill() public {
        // liquidity only in a narrow band: once the price leaves it, nothing more can be sold
        MockERC20 thin = new MockERC20("THIN", 18);
        PoolKey memory k = PoolKey(address(0), address(thin), 3000, 60, address(0));
        IPoolManagerAdmin(POOL_MANAGER).initialize(k, PRICE_ONE);
        LiquidityHelper lp = new LiquidityHelper(POOL_MANAGER);
        vm.deal(address(lp), 1 ether);
        thin.mint(address(lp), 1 ether);
        lp.addRange(k, 1e15, -60, 60);

        PoolKey[] memory route = new PoolKey[](1);
        route[0] = k;
        vm.deal(address(this), 1 ether);
        vm.expectPartialRevert(UniswapV4Adapter.PartialFill.selector);
        v4.swap{value: 1 ether}(ETH, address(thin), 1 ether, 0, abi.encode(route));
    }
}
