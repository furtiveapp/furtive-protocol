// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FurtiveVault} from "../src/FurtiveVault.sol";

/// A real deposit and private partial withdrawal on testnet, with a real proof.
/// Needs an empty vault (it rebuilds the tree from its own deposit only).
///   FOUNDRY_PROFILE=deploy forge script script/LiveFlow.s.sol --rpc-url rh_testnet --broadcast --slow --ffi
contract LiveFlow is Script {
    function run() external {
        FurtiveVault vault = FurtiveVault(payable(vm.envAddress("VAULT")));
        require(vault.treeSize() == 0, "expects an empty vault");
        uint256 pk = vm.envUint("DEPLOYER_PK");

        uint256 sk = uint256(keccak256(abi.encode("furtive-live", block.timestamp))) % 2 ** 250;
        address recipient = address(uint160(uint256(keccak256(abi.encode("fresh-wallet", block.timestamp)))));

        (uint256 npk, uint256 commitment) = _note(sk, 1, address(0), 0.001 ether);
        (uint256 changeNpk,) = _note(sk, 2, address(0), 0.0006 ether);

        vm.startBroadcast(pk);
        (uint256 c,) = vault.deposit{value: 0.001 ether}(address(0), 0.001 ether, npk, "");
        require(c == commitment, "sdk and vault disagree");

        FurtiveVault.ExtData memory e;
        e.recipient = recipient;
        e.deadline = block.timestamp + 1 hours;
        string memory j = string.concat(
            '{"leaves":["', vm.toString(commitment), '"],"asset":"0x0000000000000000000000000000000000000000","inputs":[{"sk":"',
            vm.toString(sk), '","blinding":"1","amount":"1000000000000000","commitment":"', vm.toString(commitment),
            '"}],"outputs":[{"npk":"', vm.toString(changeNpk), '","amount":"600000000000000"}],"publicAmount":"400000000000000","extDataHash":"',
            vm.toString(vault.extDataHash(e)), '"}'
        );
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/furtive.mjs";
        cmd[2] = "prove";
        cmd[3] = j;
        uint256[14] memory w = abi.decode(vm.ffi(cmd), (uint256[14]));

        FurtiveVault.Proof memory p;
        p.a = [w[0], w[1]];
        p.b = [[w[2], w[3]], [w[4], w[5]]];
        p.c = [w[6], w[7]];
        FurtiveVault.Transaction memory t;
        t.root = w[8];
        t.treeDepth = w[9];
        t.asset = address(0);
        t.publicAmount = 0.0004 ether;
        t.nullifiers = [w[10], w[11]];
        t.commitments = [w[12], w[13]];
        vault.transact(p, t, e);
        vm.stopBroadcast();

        console.log("fresh wallet", recipient);
        console.log("vault holds (wei)", vault.held(address(0)));
    }

    function _note(uint256 sk, uint256 blinding, address asset, uint256 amount) internal returns (uint256 npk, uint256 commitment) {
        string[] memory cmd = new string[](7);
        cmd[0] = "node";
        cmd[1] = "test/ffi/furtive.mjs";
        cmd[2] = "note";
        cmd[3] = vm.toString(sk);
        cmd[4] = vm.toString(blinding);
        cmd[5] = vm.toString(asset);
        cmd[6] = vm.toString(amount);
        (, npk, commitment) = abi.decode(vm.ffi(cmd), (uint256, uint256, uint256));
    }
}
