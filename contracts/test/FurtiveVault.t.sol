// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FurtiveVault} from "../src/FurtiveVault.sol";
import {Groth16Verifier} from "../src/verifiers/TransactVerifier.sol";
import {MockERC20, MockAdapter, ReentrantAdapter} from "./mocks/Mocks.sol";

/// @dev Every proof in this file is a real Groth16 proof made by the SDK
///      (test/ffi/furtive.mjs) against the development keys.
contract FurtiveVaultTest is Test {
    address constant ETH = address(0);

    FurtiveVault vault;
    MockERC20 usdg;
    MockAdapter adapter;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");

    /// Every leaf in the vault's tree, in insertion order, as the SDK needs it.
    uint256[] leaves;

    struct Note {
        uint256 sk;
        uint256 blinding;
        uint256 npk;
        uint256 commitment;
        address asset;
        uint256 amount;
    }

    struct Out {
        uint256 npk;
        uint256 amount;
    }

    function setUp() public virtual {
        Groth16Verifier verifier = new Groth16Verifier();
        usdg = new MockERC20("USDG", 6);
        vault = new FurtiveVault(
            address(verifier),
            treasury,
            30, // 0.30% swap fee
            FurtiveVault.BaseAsset(ETH, 10 ether, 100 ether),
            FurtiveVault.BaseAsset(address(usdg), 50_000e6, 1_000_000e6)
        );
        adapter = new MockAdapter();
        usdg.mint(address(adapter), 10_000_000e6);
        vm.deal(address(adapter), 1_000 ether);
        vm.deal(alice, 100 ether);
        usdg.mint(alice, 1_000_000e6);
    }

    // ─────────────────────────────────────────────────────────────── deposits

    function test_deposit_makes_the_note_the_owner_expects() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        assertEq(vault.held(ETH), 1 ether);
        assertEq(address(vault).balance, 1 ether);
        assertEq(vault.treeSize(), 1);
        assertEq(vault.currentRoot(), n.commitment, "a tree of one leaf has that leaf as its root");
    }

    function test_erc20_deposit() public {
        _deposit(alice, 11, 12, address(usdg), 2_500e6);
        assertEq(vault.held(address(usdg)), 2_500e6);
        assertEq(usdg.balanceOf(address(vault)), 2_500e6);
    }

    function test_deposit_limits_follow_the_fixed_schedule() public {
        (uint256 per, uint256 total) = vault.depositLimits(ETH);
        assertEq(per, 10 ether);
        assertEq(total, 100 ether);

        Note memory n = _note(11, 12, ETH, 0);
        vm.prank(alice);
        vm.expectRevert(FurtiveVault.OverDepositLimit.selector);
        vault.deposit{value: 11 ether}(ETH, 11 ether, n.npk, "");

        vm.warp(block.timestamp + 14 days);
        (per, total) = vault.depositLimits(ETH);
        assertEq(per, 20 ether);
        assertEq(total, 200 ether);

        vm.warp(block.timestamp + 7 * 14 days);
        (per, total) = vault.depositLimits(ETH);
        assertEq(per, type(uint256).max, "limits end after eight doublings");
        assertEq(total, type(uint256).max);
    }

    function test_only_base_assets_can_be_deposited() public {
        MockERC20 meme = new MockERC20("MEME", 18);
        meme.mint(alice, 1e18);
        vm.startPrank(alice);
        meme.approve(address(vault), 1e18);
        vm.expectRevert(FurtiveVault.NotBaseAsset.selector);
        vault.deposit(address(meme), 1e18, 5, "");
        vm.stopPrank();
    }

    function test_eth_sent_directly_is_refused() public {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ───────────────────────────────────────────────────────────── withdrawals

    function test_partial_withdrawal_keeps_private_change_and_change_can_be_spent() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        Note memory change = _note(11, 22, ETH, 0.6 ether);

        FurtiveVault.ExtData memory e = _withdrawExt(bob, relayer, 0.01 ether);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) =
            _prove(_one(n), _outOne(change.npk, 0.6 ether), ETH, 0.4 ether, e);
        vault.transact(p, t, e);
        _recordOutputs(t);

        assertEq(bob.balance, 0.39 ether);
        assertEq(relayer.balance, 0.01 ether);
        assertEq(vault.held(ETH), 0.6 ether);
        assertTrue(vault.nullifierSpent(t.nullifiers[0]));

        change.commitment = t.commitments[0];
        FurtiveVault.ExtData memory e2 = _withdrawExt(bob, address(0), 0);
        (p, t) = _prove(_one(change), new Out[](0), ETH, 0.6 ether, e2);
        vault.transact(p, t, e2);

        assertEq(bob.balance, 0.99 ether);
        assertEq(vault.held(ETH), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_a_note_can_never_be_spent_twice() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        FurtiveVault.ExtData memory e = _withdrawExt(bob, address(0), 0);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vault.transact(p, t, e);

        vm.expectRevert(FurtiveVault.NullifierSpent.selector);
        vault.transact(p, t, e);
    }

    function test_changing_the_recipient_breaks_the_proof() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        FurtiveVault.ExtData memory e = _withdrawExt(bob, address(0), 0);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);

        FurtiveVault.ExtData memory stolen = _withdrawExt(relayer, address(0), 0);
        vm.expectRevert(FurtiveVault.InvalidProof.selector);
        vault.transact(p, t, stolen);

        e.relayerFee = 0.5 ether;
        e.relayer = relayer;
        vm.expectRevert(FurtiveVault.InvalidProof.selector);
        vault.transact(p, t, e);
    }

    function test_changing_the_amount_breaks_the_proof() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        vm.deal(bob, 5 ether);
        _deposit(bob, 41, 42, ETH, 5 ether);
        FurtiveVault.ExtData memory e = _withdrawExt(bob, address(0), 0);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        t.publicAmount = 2 ether;
        vm.expectRevert(FurtiveVault.InvalidProof.selector);
        vault.transact(p, t, e);
    }

    // ───────────────────────────────────────────────────────────────── swaps

    function test_private_swap_then_withdraw_the_proceeds() public {
        adapter.setRate(3_000e6, 1e18); // 1 ETH = 3,000 USDG
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        Note memory proceeds = _note(31, 32, address(usdg), 0);

        FurtiveVault.ExtData memory e = _swapExt(address(adapter), address(usdg), 2_900e6, proceeds.npk);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vault.transact(p, t, e);
        _recordOutputs(t);

        // 0.30% of 1 ETH stays as the fee; the rest is sold, and all of it comes back as a note
        assertEq(vault.feesOwed(ETH), 0.003 ether);
        assertEq(vault.held(ETH), 0);
        assertEq(vault.held(address(usdg)), 2_991e6);
        assertEq(usdg.balanceOf(address(vault)), 2_991e6);

        proceeds.amount = 2_991e6;
        proceeds.commitment = _commit(proceeds.npk, address(usdg), proceeds.amount);
        leaves.push(proceeds.commitment);

        FurtiveVault.ExtData memory w = _withdrawExt(bob, address(0), 0);
        (p, t) = _prove(_one(proceeds), new Out[](0), address(usdg), 2_991e6, w);
        vault.transact(p, t, w);
        assertEq(usdg.balanceOf(bob), 2_991e6);

        vault.collectFees(ETH);
        assertEq(treasury.balance, 0.003 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_swap_below_the_minimum_reverts_and_leaves_the_note_unspent() public {
        adapter.setRate(2_000e6, 1e18);
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        Note memory proceeds = _note(31, 32, address(usdg), 0);

        FurtiveVault.ExtData memory e = _swapExt(address(adapter), address(usdg), 2_900e6, proceeds.npk);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vm.expectRevert(abi.encodeWithSelector(FurtiveVault.ShortOutput.selector, 1_994e6, 2_900e6));
        vault.transact(p, t, e);

        assertFalse(vault.nullifierSpent(t.nullifiers[0]));
        assertEq(vault.held(ETH), 1 ether);
    }

    function test_an_adapter_cannot_reenter_the_vault() public {
        ReentrantAdapter bad = new ReentrantAdapter();
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        FurtiveVault.ExtData memory e = _swapExt(address(bad), address(usdg), 1, 5);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vm.expectRevert(FurtiveVault.Reentrancy.selector);
        vault.transact(p, t, e);
    }

    function test_expired_swap_reverts() public {
        Note memory n = _deposit(alice, 11, 12, ETH, 1 ether);
        FurtiveVault.ExtData memory e = _swapExt(address(adapter), address(usdg), 1, 5);
        (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t) = _prove(_one(n), new Out[](0), ETH, 1 ether, e);
        vm.warp(e.deadline + 1);
        vm.expectRevert(FurtiveVault.Expired.selector);
        vault.transact(p, t, e);
    }

    // ───────────────────────────────────────────────────────────── helpers

    function _note(uint256 sk, uint256 blinding, address asset, uint256 amount) internal returns (Note memory n) {
        string[] memory cmd = new string[](7);
        cmd[0] = "node";
        cmd[1] = "test/ffi/furtive.mjs";
        cmd[2] = "note";
        cmd[3] = vm.toString(sk);
        cmd[4] = vm.toString(blinding);
        cmd[5] = vm.toString(asset);
        cmd[6] = vm.toString(amount);
        (, uint256 npk, uint256 commitment) = abi.decode(vm.ffi(cmd), (uint256, uint256, uint256));
        n = Note(sk, blinding, npk, commitment, asset, amount);
    }

    function _commit(uint256 npk, address asset, uint256 amount) internal returns (uint256) {
        string[] memory cmd = new string[](6);
        cmd[0] = "node";
        cmd[1] = "test/ffi/furtive.mjs";
        cmd[2] = "commit";
        cmd[3] = vm.toString(npk);
        cmd[4] = vm.toString(asset);
        cmd[5] = vm.toString(amount);
        return abi.decode(vm.ffi(cmd), (uint256));
    }

    function _deposit(address from, uint256 sk, uint256 blinding, address asset, uint256 amount)
        internal
        returns (Note memory n)
    {
        n = _note(sk, blinding, asset, amount);
        vm.startPrank(from);
        uint256 c;
        if (asset == ETH) {
            (c,) = vault.deposit{value: amount}(asset, amount, n.npk, "");
        } else {
            MockERC20(asset).approve(address(vault), amount);
            (c,) = vault.deposit(asset, amount, n.npk, "");
        }
        vm.stopPrank();
        assertEq(c, n.commitment, "the vault and the SDK agree on the note");
        leaves.push(c);
    }

    function _prove(Note[] memory ins, Out[] memory outs, address asset, uint256 publicAmount, FurtiveVault.ExtData memory e)
        internal
        returns (FurtiveVault.Proof memory p, FurtiveVault.Transaction memory t)
    {
        string memory j = string.concat('{"leaves":[', _leavesJson(), '],"asset":"', vm.toString(asset), '","inputs":[');
        for (uint256 i = 0; i < ins.length; i++) {
            j = string.concat(
                j,
                i == 0 ? "" : ",",
                '{"sk":"', vm.toString(ins[i].sk),
                '","blinding":"', vm.toString(ins[i].blinding),
                '","amount":"', vm.toString(ins[i].amount),
                '","commitment":"', vm.toString(ins[i].commitment), '"}'
            );
        }
        j = string.concat(j, '],"outputs":[');
        for (uint256 i = 0; i < outs.length; i++) {
            j = string.concat(
                j, i == 0 ? "" : ",", '{"npk":"', vm.toString(outs[i].npk), '","amount":"', vm.toString(outs[i].amount), '"}'
            );
        }
        j = string.concat(
            j, '],"publicAmount":"', vm.toString(publicAmount), '","extDataHash":"', vm.toString(vault.extDataHash(e)), '"}'
        );

        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/furtive.mjs";
        cmd[2] = "prove";
        cmd[3] = j;
        uint256[14] memory w = abi.decode(vm.ffi(cmd), (uint256[14]));

        p.a = [w[0], w[1]];
        p.b = [[w[2], w[3]], [w[4], w[5]]];
        p.c = [w[6], w[7]];
        t.root = w[8];
        t.treeDepth = w[9];
        t.asset = asset;
        t.publicAmount = publicAmount;
        t.nullifiers = [w[10], w[11]];
        t.commitments = [w[12], w[13]];
    }

    function _leavesJson() internal view returns (string memory s) {
        for (uint256 i = 0; i < leaves.length; i++) {
            s = string.concat(s, i == 0 ? "" : ",", '"', vm.toString(leaves[i]), '"');
        }
    }

    function _recordOutputs(FurtiveVault.Transaction memory t) internal {
        leaves.push(t.commitments[0]);
        leaves.push(t.commitments[1]);
    }

    function _withdrawExt(address recipient, address relayer_, uint256 fee)
        internal
        view
        returns (FurtiveVault.ExtData memory e)
    {
        e.recipient = recipient;
        e.relayer = relayer_;
        e.relayerFee = fee;
        e.deadline = block.timestamp + 1 hours;
    }

    function _swapExt(address adapter_, address assetOut, uint256 minOut, uint256 outNpk)
        internal
        view
        returns (FurtiveVault.ExtData memory e)
    {
        e.adapter = adapter_;
        e.assetOut = assetOut;
        e.minOut = minOut;
        e.outNpk = outNpk;
        e.deadline = block.timestamp + 1 hours;
    }

    function _one(Note memory n) internal pure returns (Note[] memory a) {
        a = new Note[](1);
        a[0] = n;
    }

    function _outOne(uint256 npk, uint256 amount) internal pure returns (Out[] memory a) {
        a = new Out[](1);
        a[0] = Out(npk, amount);
    }
}
