// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FurtiveVault} from "../src/FurtiveVault.sol";
import {Groth16Verifier} from "../src/verifiers/TransactVerifier.sol";
import {UniswapV4Adapter} from "../src/adapters/UniswapV4Adapter.sol";

/// Robinhood Chain testnet (46630). Development proving keys: testnet only.
///   forge script script/DeployTestnet.s.sol --rpc-url rh_testnet --broadcast
contract DeployTestnet is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        Groth16Verifier verifier = new Groth16Verifier();
        FurtiveVault vault = new FurtiveVault(
            address(verifier),
            POOL_MANAGER,
            deployer, // testnet treasury
            30, // 0.30% swap fee
            FurtiveVault.BaseAsset(address(0), 1 ether, 50 ether),
            FurtiveVault.BaseAsset(USDG, 5_000e6, 100_000e6)
        );
        UniswapV4Adapter adapter = new UniswapV4Adapter(POOL_MANAGER);
        vm.stopBroadcast();

        console.log("verifier", address(verifier));
        console.log("vault   ", address(vault));
        console.log("adapter ", address(adapter));
    }
}
