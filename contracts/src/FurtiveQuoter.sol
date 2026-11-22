// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager, PoolKey, SwapParams} from "./adapters/UniswapV4Adapter.sol";

/**
 * @title FurtiveQuoter
 * @notice Prices a route through Uniswap v4 pools without moving anything. It
 *         runs the swaps inside the PoolManager and then undoes them by
 *         reverting, so the call only ever reads. Holds nothing, no owner.
 *
 * quote() returns what `amountIn` of `assetIn` would buy along `route`, or
 * ok = false when the route cannot fill (no liquidity, a hook refuses, a token
 * that cannot be moved). The app uses the same call to test whether a token
 * can be sold again.
 */
contract FurtiveQuoter {
    IPoolManager public immutable poolManager;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    error QuoteResult(uint256 amountOut, uint256 filled);
    error NotPoolManager();

    constructor(address poolManager_) {
        poolManager = IPoolManager(poolManager_);
    }

    /// @return ok whether the route filled in full; amountOut what it would buy.
    function quote(address assetIn, uint256 amountIn, PoolKey[] calldata route)
        external
        returns (bool ok, uint256 amountOut)
    {
        try poolManager.unlock(abi.encode(assetIn, amountIn, route)) {
            return (false, 0); // the callback always reverts; reaching here means it did not run
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != QuoteResult.selector) return (false, 0);
            uint256 filled;
            assembly {
                amountOut := mload(add(reason, 36))
                filled := mload(add(reason, 68))
            }
            return (filled == amountIn, amountOut);
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address cur, uint256 amountIn, PoolKey[] memory route) = abi.decode(data, (address, uint256, PoolKey[]));
        uint256 amount = amountIn;
        uint256 filled = amountIn;
        for (uint256 i = 0; i < route.length; i++) {
            PoolKey memory k = route[i];
            bool z = k.currency0 == cur;
            int256 delta = poolManager.swap(
                k,
                SwapParams({zeroForOne: z, amountSpecified: -int256(amount), sqrtPriceLimitX96: z ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1}),
                ""
            );
            int128 inD = z ? int128(delta >> 128) : int128(delta);
            int128 outD = z ? int128(delta) : int128(delta >> 128);
            if (i == 0) filled = inD < 0 ? uint256(uint128(-inD)) : 0;
            amount = outD > 0 ? uint256(uint128(outD)) : 0;
            cur = z ? k.currency1 : k.currency0;
        }
        revert QuoteResult(amount, filled);
    }
}
