// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @notice Uniswap v4 PoolKey. Currency and IHooks are addresses; native ETH is address(0).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Uniswap v4 swap parameters. A negative amountSpecified is an exact input.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @return delta BalanceDelta: amount0 in the upper 128 bits, amount1 in the lower, both signed.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/**
 * @title UniswapV4Adapter
 * @notice Sells an exact amount through one to three Uniswap v4 pools and sends
 *         everything it buys straight to the caller.
 *
 * Holds nothing and controls nothing:
 *  - No owner, no settings, no storage beyond a re-entry latch.
 *  - It never keeps a balance: the whole input goes to the PoolManager and the
 *    whole output is taken directly to the caller in the same call.
 *  - The input must be filled in full. A pool that runs out of liquidity, or a
 *    hook that keeps part of the input, makes the swap revert instead of
 *    filling partly.
 *  - It checks minOut itself, and the vault checks what really arrived again.
 *
 * route = abi.encode(PoolKey[]), pools in order from assetIn to assetOut.
 */
contract UniswapV4Adapter is ISwapAdapter {
    IPoolManager public immutable poolManager;

    uint256 public constant MAX_HOPS = 3;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @dev Who the running swap pays. Zero when no swap is running.
    address private _payee;

    struct Unlock {
        PoolKey[] hops;
        bool[] zeroForOne;
        address assetIn;
        address assetOut;
        uint256 amountIn;
        uint256 minOut;
        address payee;
    }

    error ZeroAddress();
    error BadRoute();
    error BadAmount();
    error NotPoolManager();
    error Reentrancy();
    error PartialFill(uint256 spent, uint256 wanted);
    error ShortOutput(uint256 got, uint256 wanted);
    error TokenCallFailed();

    constructor(address poolManager_) {
        if (poolManager_ == address(0) || poolManager_.code.length == 0) revert ZeroAddress();
        poolManager = IPoolManager(poolManager_);
    }

    /// @inheritdoc ISwapAdapter
    function swap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        payable
        returns (uint256 amountOut)
    {
        if (_payee != address(0)) revert Reentrancy();
        if (amountIn == 0 || amountIn > uint256(int256(type(int128).max))) revert BadAmount();
        if (assetIn == address(0) ? msg.value != amountIn : msg.value != 0) revert BadAmount();

        PoolKey[] memory hops = abi.decode(data, (PoolKey[]));
        bool[] memory zeroForOne = _walk(hops, assetIn, assetOut);

        _payee = msg.sender;
        bytes memory res =
            poolManager.unlock(abi.encode(Unlock(hops, zeroForOne, assetIn, assetOut, amountIn, minOut, msg.sender)));
        _payee = address(0);
        amountOut = abi.decode(res, (uint256));
    }

    /// @notice Called by the PoolManager inside unlock(), only while a swap runs.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _payee == address(0)) revert NotPoolManager();
        Unlock memory u = abi.decode(data, (Unlock));

        uint256 amount = u.amountIn;
        for (uint256 i = 0; i < u.hops.length; i++) {
            bool z = u.zeroForOne[i];
            int256 delta = poolManager.swap(
                u.hops[i],
                SwapParams({
                    zeroForOne: z,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: z ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 a0 = int128(delta >> 128);
            int128 a1 = int128(delta);
            int128 inD = z ? a0 : a1;
            int128 outD = z ? a1 : a0;
            // the whole input of this hop must have been used, no more and no less
            if (inD >= 0 || uint256(uint128(-inD)) != amount) {
                revert PartialFill(inD >= 0 ? 0 : uint256(uint128(-inD)), amount);
            }
            if (outD <= 0) revert ShortOutput(0, u.minOut);
            amount = uint256(uint128(outD));
        }
        if (amount < u.minOut) revert ShortOutput(amount, u.minOut);

        // Pay the input.
        if (u.assetIn == address(0)) {
            poolManager.sync(address(0));
            poolManager.settle{value: u.amountIn}();
        } else {
            poolManager.sync(u.assetIn);
            _transfer(u.assetIn, address(poolManager), u.amountIn);
            poolManager.settle();
        }
        // Take the whole output straight to the caller.
        poolManager.take(u.assetOut, u.payee, amount);
        return abi.encode(amount);
    }

    /// @dev Checks the route runs from assetIn to assetOut with each currency
    ///      once, and returns each hop's direction.
    function _walk(PoolKey[] memory hops, address assetIn, address assetOut)
        private
        pure
        returns (bool[] memory zeroForOne)
    {
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS || assetIn == assetOut) revert BadRoute();
        address[] memory path = new address[](n + 1);
        zeroForOne = new bool[](n);
        address cur = assetIn;
        path[0] = cur;
        for (uint256 i = 0; i < n; i++) {
            PoolKey memory k = hops[i];
            if (k.currency0 == cur) {
                zeroForOne[i] = true;
                cur = k.currency1;
            } else if (k.currency1 == cur) {
                zeroForOne[i] = false;
                cur = k.currency0;
            } else {
                revert BadRoute();
            }
            path[i + 1] = cur;
        }
        if (cur != assetOut) revert BadRoute();
        for (uint256 i = 0; i <= n; i++) {
            for (uint256 j = i + 1; j <= n; j++) {
                if (path[i] == path[j]) revert BadRoute();
            }
        }
    }

    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }

    receive() external payable {
        if (_payee == address(0)) revert NotPoolManager();
    }
}
