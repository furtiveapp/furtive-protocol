// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolKey} from "../src/adapters/UniswapV4Adapter.sol";
import {TestToken, ModifyLiquidityParams, IPM} from "./TestMarket.s.sol";

/// Seeds the practice token's pool with liquidity concentrated around its price
/// (about half to double), so small practice trades barely move it. Testnet only.
contract RangeSeeder {
    IPM immutable pm;

    constructor(address pm_) payable {
        pm = IPM(pm_);
    }

    function seed(PoolKey memory key, uint160 price, int24 lower, int24 upper, int256 liquidity) external payable {
        pm.initialize(key, price);
        pm.unlock(abi.encode(key, lower, upper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int24 lower, int24 upper, int256 liquidity) = abi.decode(data, (PoolKey, int24, int24, int256));
        (int256 d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        int128 d0 = int128(d >> 128);
        int128 d1 = int128(d);
        if (d0 < 0) {
            pm.sync(address(0));
            pm.settle{value: uint256(uint128(-d0))}();
        }
        if (d1 < 0) {
            pm.sync(key.currency1);
            TestToken(key.currency1).transfer(address(pm), uint256(uint128(-d1)));
            pm.settle();
        }
        return "";
    }

    receive() external payable {}
}

///   FOUNDRY_PROFILE=deploy forge script script/PracticePool.s.sol --tc PracticePool --rpc-url rh_testnet --broadcast --slow
contract PracticePool is Script {
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        TestToken peek = new TestToken("Peek Test Coin", "PEEK", 1_000_000_000 ether);
        RangeSeeder seeder = new RangeSeeder{value: 0.042 ether}(PM);
        peek.transfer(address(seeder), 1_000_000 ether);
        // 1 ETH = 1,000,000 PEEK (tick ~138162); liquidity from about 0.5x to 2x that price
        uint160 price = 79228162514264337593543950336000;
        PoolKey memory key = PoolKey(address(0), address(peek), 3000, 60, address(0));
        seeder.seed(key, price, 131160, 145140, 115e18);
        vm.stopBroadcast();
        console.log("PEEK  ", address(peek));
        console.log("seeder", address(seeder));
    }
}
