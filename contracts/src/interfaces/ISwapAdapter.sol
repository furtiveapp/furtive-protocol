// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A venue the vault can sell a note's funds through.
/// @dev The vault sends `amountIn` of `assetIn` first (for native ETH, as the
///      call's value), then calls `swap`. The adapter must send at least
///      `minOut` of `assetOut` back to the vault (msg.sender) before returning.
///      The vault measures what arrived itself and never trusts the return value.
///      The vault never gives an adapter an approval, so an adapter can only ever
///      touch the amount it was sent for that one swap.
interface ISwapAdapter {
    function swap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        payable
        returns (uint256 amountOut);
}
