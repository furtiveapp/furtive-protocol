pragma circom 2.2.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../lib/merkleTree.circom";

// Furtive transaction circuit.
//
// A note is three numbers hashed together:
//   commitment = Poseidon(npk, asset, amount)
//   npk        = Poseidon(pk, blinding)      the note's one-time public key
//   pk         = Poseidon(sk)                the owner's public key
//
// Only the holder of sk can spend a note. Spending reveals its nullifier,
//   nullifier = Poseidon(sk, commitment)
// which the vault records so a note can never be spent twice, while saying
// nothing about which note it was.
//
// One proof spends up to two notes of one asset and makes up to two new notes
// of the same asset, and may send `publicAmount` of that asset out of the
// vault (to a wallet, or to a swap). Value is conserved:
//   in[0] + in[1] = out[0] + out[1] + publicAmount
//
// An input with amount 0 is a dummy: its tree check is skipped, so a single
// note can be spent alone. Its nullifier is still published, so a dummy must
// use a fresh random sk.
//
// extDataHash binds everything the proof does not cover itself (recipient,
// relayer, fee, swap terms, encrypted notes). Changing any of it changes the
// hash and the vault rejects the proof.

template Note() {
    signal input npk;
    signal input asset;
    signal input amount;
    signal output commitment;

    component h = Poseidon(3);
    h.inputs[0] <== npk;
    h.inputs[1] <== asset;
    h.inputs[2] <== amount;
    commitment <== h.out;
}

template Transact(maxDepth, nIns, nOuts) {
    // ---------- public ----------
    signal input root;
    signal input treeDepth;
    signal input asset;
    signal input publicAmount;
    signal input extDataHash;
    signal input inNullifier[nIns];
    signal input outCommitment[nOuts];

    // ---------- private ----------
    signal input inAmount[nIns];
    signal input inSk[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inSiblings[nIns][maxDepth];

    signal input outAmount[nOuts];
    signal input outNpk[nOuts];

    component inPk[nIns];
    component inNpk[nIns];
    component inNote[nIns];
    component inNull[nIns];
    component inTree[nIns];
    component inRange[nIns];
    component inIsDummy[nIns];

    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inRange[i] = Num2Bits(248);
        inRange[i].in <== inAmount[i];

        inPk[i] = Poseidon(1);
        inPk[i].inputs[0] <== inSk[i];

        inNpk[i] = Poseidon(2);
        inNpk[i].inputs[0] <== inPk[i].out;
        inNpk[i].inputs[1] <== inBlinding[i];

        inNote[i] = Note();
        inNote[i].npk <== inNpk[i].out;
        inNote[i].asset <== asset;
        inNote[i].amount <== inAmount[i];

        inNull[i] = Poseidon(2);
        inNull[i].inputs[0] <== inSk[i];
        inNull[i].inputs[1] <== inNote[i].commitment;
        inNull[i].out === inNullifier[i];

        inTree[i] = LeanIMTInclusionProof(maxDepth);
        inTree[i].leaf <== inNote[i].commitment;
        inTree[i].leafIndex <== inLeafIndex[i];
        inTree[i].siblings <== inSiblings[i];
        inTree[i].actualDepth <== treeDepth;

        // A real input must be in the tree. A dummy (amount 0) is exempt.
        inIsDummy[i] = IsZero();
        inIsDummy[i].in <== inAmount[i];
        (inTree[i].out - root) * (1 - inIsDummy[i].out) === 0;

        sumIns += inAmount[i];
    }

    // The two nullifiers must differ, or one note could be counted twice.
    component sameNull[nIns][nIns];
    for (var i = 0; i < nIns; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNull[i][j] = IsEqual();
            sameNull[i][j].in[0] <== inNullifier[i];
            sameNull[i][j].in[1] <== inNullifier[j];
            sameNull[i][j].out === 0;
        }
    }

    component outNote[nOuts];
    component outRange[nOuts];
    var sumOuts = 0;
    for (var k = 0; k < nOuts; k++) {
        outRange[k] = Num2Bits(248);
        outRange[k].in <== outAmount[k];

        outNote[k] = Note();
        outNote[k].npk <== outNpk[k];
        outNote[k].asset <== asset;
        outNote[k].amount <== outAmount[k];
        outNote[k].commitment === outCommitment[k];

        sumOuts += outAmount[k];
    }

    component publicRange = Num2Bits(248);
    publicRange.in <== publicAmount;

    sumIns === sumOuts + publicAmount;

    // Bind the external data into the proof.
    signal extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, treeDepth, asset, publicAmount, extDataHash, inNullifier, outCommitment]} = Transact(32, 2, 2);
