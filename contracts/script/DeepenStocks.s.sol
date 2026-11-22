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

interface IPMx {
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory p, bytes calldata hookData) external returns (int256, int256);
    function settle() external payable returns (uint256);
}

/// Adds ETH just above the current price of a testnet Stock Token pool, the side
/// sellers are paid from. ETH only: the range sits entirely above the price.
contract EthAdder {
    IPMx immutable pm;

    constructor(address pm_) {
        pm = IPMx(pm_);
    }

    function add(address token, uint24 fee, int24 lower, int24 upper, int256 liquidity) external payable {
        pm.unlock(abi.encode(PoolKey(address(0), token, fee, 60, address(0)), lower, upper, liquidity));
        (bool ok,) = msg.sender.call{value: address(this).balance}("");
        require(ok, "refund");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int24 lower, int24 upper, int256 liquidity) = abi.decode(data, (PoolKey, int24, int24, int256));
        (int256 d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        int256 eth = int256(int128(d >> 128));
        int256 tok = int256(int128(d));
        require(tok == 0, "token side");
        if (eth < 0) pm.settle{value: uint256(-eth)}();
        return "";
    }

    receive() external payable {}
}

///   FOUNDRY_PROFILE=deploy forge script script/DeepenStocks.s.sol --tc DeepenStocks --rpc-url rh_testnet --broadcast --slow
contract DeepenStocks is Script {
    EthAdder adder;

    function add(address token, uint24 fee, int24 lower, int24 upper, int256 liquidity) internal {
        adder.add{value: 0.016 ether}(token, fee, lower, upper, liquidity);
    }

    function run() external {
        require(block.chainid == 46630, "testnet only");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        adder = new EthAdder(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        add(0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, 2900, 15600, 22560, 107997240958391888); // TSLA
        add(0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02, 2900, 19020, 25980, 128136631817145728); // AMZN
        add(0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0, 2900, 24420, 31380, 167852166648662976); // PLTR
        add(0x71178BAc73cBeb415514eB542a8995b82669778d, 2900, 13440, 20400, 96941827272158592); // AMD
        add(0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93, 2800, 33960, 40920, 270442574858931104); // NFLX
        vm.stopBroadcast();
        console.log("adder", address(adder));
    }
}
