// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolKey} from "../src/adapters/UniswapV4Adapter.sol";

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPM {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory p, bytes calldata hookData) external returns (int256, int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

interface IERC20T {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Opens an ETH pool for a testnet Stock Token at a set price: the token below the
/// price (so it can be bought) and a little ETH above it (so it can be sold back).
/// Testnet only. Pays from the caller; keeps the positions.
contract RangeSeeder {
    IPM immutable pm;
    address private payer;

    constructor(address pm_) {
        pm = IPM(pm_);
    }

    function seed(address token, uint24 fee, int24 spacing, uint160 sqrtPriceX96, int24 tick, int256 liqBelow, int256 liqAbove) external payable {
        payer = msg.sender;
        PoolKey memory key = PoolKey(address(0), token, fee, spacing, address(0));
        pm.initialize(key, sqrtPriceX96);
        pm.unlock(abi.encode(key, tick, liqBelow, liqAbove));
        payer = address(0);
        if (address(this).balance > 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int24 tick, int256 below, int256 above) = abi.decode(data, (PoolKey, int24, int256, int256));
        int24 w = 6960;
        (int256 d1,) = pm.modifyLiquidity(key, ModifyLiquidityParams(tick - w, tick, below, 0), "");
        (int256 d2,) = pm.modifyLiquidity(key, ModifyLiquidityParams(tick, tick + w, above, 0), "");
        int256 eth = int256(int128(d1 >> 128)) + int256(int128(d2 >> 128));
        int256 tok = int256(int128(d1)) + int256(int128(d2));
        if (eth < 0) {
            pm.sync(address(0));
            pm.settle{value: uint256(-eth)}();
        }
        if (tok < 0) {
            pm.sync(key.currency1);
            IERC20T(key.currency1).transferFrom(payer, address(pm), uint256(-tok));
            pm.settle();
        }
        return "";
    }

    receive() external payable {}
}

///   FOUNDRY_PROFILE=deploy forge script script/StockMarket.s.sol --tc StockMarket --rpc-url rh_testnet --broadcast --slow
contract StockMarket is Script {
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    RangeSeeder seeder;

    function seed(address token, uint24 fee, int24 spacing, uint160 sqrtPriceX96, int24 tick, int256 below, int256 above) internal {
        IERC20T(token).approve(address(seeder), 4.6 ether);
        seeder.seed{value: 0.00016 ether}(token, fee, spacing, sqrtPriceX96, tick, below, above);
    }

    function run() external {
        require(block.chainid == 46630, "testnet only");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        seeder = new RangeSeeder(PM);
        // Prices from the most liquid Robinhood Chain mainnet pools, ETH at $1,707.34.
        seed(0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, 2900, 60, 172827299224465207903194710016, 15600, 6949152726035788800, 1102239881946473); // TSLA $357.80
        seed(0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02, 2900, 60, 205056238586770667546353860608, 19020, 5856945908187446272, 1307786242257466); // AMZN $254.46
        seed(0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0, 2900, 60, 268612756894777860978234097664, 24420, 4471132761611755520, 1713130360640992); // PLTR $147.70
        seed(0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93, 2900, 60, 393173790154478152568721637376, 32040, 3054637230694397440, 2507542697183873); // NFLX $69.19
        seed(0x71178BAc73cBeb415514eB542a8995b82669778d, 2900, 60, 155135390873426702564088348672, 13440, 7741646124571157504, 989406278344711); // AMD $444.36
        vm.stopBroadcast();
        console.log("seeder", address(seeder));
    }
}
