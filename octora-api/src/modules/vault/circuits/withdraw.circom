pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Verifies a Merkle proof using Poseidon hash
// For each level: hash(left, right) where the path index determines ordering
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hashers[levels];
    component indexBits[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Constrain pathIndices to be 0 or 1
        indexBits[i] = Num2Bits(1);
        indexBits[i].in <== pathIndices[i];

        hashers[i] = Poseidon(2);

        // If pathIndices[i] == 0: hash(current, sibling)
        // If pathIndices[i] == 1: hash(sibling, current)
        hashers[i].inputs[0] <== levelHashes[i] + (pathElements[i] - levelHashes[i]) * pathIndices[i];
        hashers[i].inputs[1] <== pathElements[i] + (levelHashes[i] - pathElements[i]) * pathIndices[i];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root === levelHashes[levels];
}

// Withdraw circuit for the vault mixer
//
// Proves: "I know (secret, nullifier) such that Poseidon(secret, nullifier) is
// a leaf in the Merkle tree with the given root. I reveal Poseidon(nullifier)
// to prevent double-spending."
//
// Public inputs: root, nullifierHash, recipient, relayer, fee
// Private inputs: secret, nullifier, pathElements[], pathIndices[]
template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input relayer;
    signal input fee;

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Compute commitment = Poseidon(secret, nullifier)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== nullifier;

    // 2. Verify nullifierHash = Poseidon(nullifier)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // 3. Verify commitment is in the Merkle tree
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commitmentHasher.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 4. Constrain recipient and fee to prevent tx front-running
    // Square constraints ensure these values are bound to the proof
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal feeSquare;
    feeSquare <== fee * fee;
    signal relayerSquare;
    relayerSquare <== relayer * relayer;
}

// 20 levels = 2^20 = ~1,048,576 possible deposits
component main {public [root, nullifierHash, recipient, relayer, fee]} = Withdraw(20);
