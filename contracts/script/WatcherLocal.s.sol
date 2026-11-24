// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FurtiveVault} from "../src/FurtiveVault.sol";
import {Groth16Verifier} from "../src/verifiers/TransactVerifier.sol";
import {MockERC20, MockAdapter, MockPoolManager} from "../test/mocks/Mocks.sol";

/// A local chain for testing the order-watcher end to end (anvil only).
///   anvil, then: forge script script/WatcherLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract WatcherLocal is Script {
    function run() external {
        require(block.chainid == 31337, "anvil only");
        uint256 pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil's first test key
        vm.startBroadcast(pk);
        Groth16Verifier verifier = new Groth16Verifier();
        MockPoolManager pm = new MockPoolManager();
        MockERC20 token = new MockERC20("Test USD", 6);
        FurtiveVault vault = new FurtiveVault(
            address(verifier), address(pm), vm.addr(pk), 30,
            FurtiveVault.BaseAsset(address(0), 1 ether, 50 ether),
            FurtiveVault.BaseAsset(address(token), 5_000e6, 100_000e6)
        );
        MockAdapter adapter = new MockAdapter();
        adapter.setRate(3000e6, 1 ether); // 1 ETH buys 3000 test USD
        token.mint(address(adapter), 1_000_000e6);
        vm.stopBroadcast();
        console.log("vault", address(vault));
        console.log("adapter", address(adapter));
        console.log("pm", address(pm));
        console.log("token", address(token));
    }
}
