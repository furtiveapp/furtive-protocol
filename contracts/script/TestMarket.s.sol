// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FurtiveQuoter} from "../src/FurtiveQuoter.sol";
import {PoolKey} from "../src/adapters/UniswapV4Adapter.sol";

/// A plain ERC-20 for testnet trading. Fixed supply, minted once to the deployer.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint256 supply) {
        name = n;
        symbol = s;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}

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

/// Seeds a full-range ETH pool for a test token. Keeps the position; testnet only.
contract Seeder {
    IPM immutable pm;
    constructor(address pm_) payable {
        pm = IPM(pm_);
    }

    function seed(PoolKey memory key, uint160 price, int256 liquidity) external payable {
        pm.initialize(key, price);
        pm.unlock(abi.encode(key, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int256 liquidity) = abi.decode(data, (PoolKey, int256));
        (int256 d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, liquidity, 0), "");
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

///   FOUNDRY_PROFILE=deploy forge script script/TestMarket.s.sol --rpc-url rh_testnet --broadcast --slow
contract TestMarket is Script {
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        FurtiveQuoter quoter = new FurtiveQuoter(PM);
        TestToken peek = new TestToken("Peek Test Coin", "PEEK", 1_000_000_000 ether);
        Seeder seeder = new Seeder{value: 0.0012 ether}(PM);
        peek.transfer(address(seeder), 1_000_000_000 ether);
        // price: 1 ETH = 1,000,000 PEEK  ->  sqrt(1e6) * 2^96
        uint160 price = 79228162514264337593543950336000;
        PoolKey memory key = PoolKey(address(0), address(peek), 3000, 60, address(0));
        // liquidity L with ~0.001 ETH: amount0 ~ L / sqrtP  ->  L = 0.001e18 * 1000
        seeder.seed(key, price, 1e18);
        vm.stopBroadcast();
        console.log("quoter", address(quoter));
        console.log("PEEK  ", address(peek));
        console.log("seeder", address(seeder));
    }
}
