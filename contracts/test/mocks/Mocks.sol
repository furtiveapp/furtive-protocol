// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";
import {FurtiveVault} from "../../src/FurtiveVault.sol";

contract MockERC20 {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Pays `rateNum / rateDen` of assetOut per unit of assetIn, from its own stock.
contract MockAdapter is ISwapAdapter {
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function swap(address, address assetOut, uint256 amountIn, uint256, bytes calldata)
        external
        payable
        returns (uint256 out)
    {
        out = amountIn * rateNum / rateDen;
        if (assetOut == address(0)) {
            (bool ok,) = msg.sender.call{value: out}("");
            require(ok, "eth");
        } else {
            MockERC20(assetOut).transfer(msg.sender, out);
        }
    }

    receive() external payable {}
}

/// @dev Tries to re-enter the vault during a swap.
contract ReentrantAdapter is ISwapAdapter {
    function swap(address, address, uint256, uint256, bytes calldata) external payable returns (uint256) {
        FurtiveVault(payable(msg.sender)).collectFees(address(0));
        return 0;
    }
}
