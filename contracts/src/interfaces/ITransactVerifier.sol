// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The Groth16 verifier generated from circuits/src/transact.circom.
/// Public signals, in order: root, treeDepth, asset, publicAmount, extDataHash,
/// inNullifier[0], inNullifier[1], outCommitment[0], outCommitment[1].
interface ITransactVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[9] calldata publicSignals
    ) external view returns (bool);
}
