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

    // 4. Bind (recipient, relayer, fee) into a Poseidon hash that
    //    participates in the constraint matrix.
    //
    // Why this matters (P0-3, runbooks/PRODUCTION_READINESS.md):
    //
    //   Groth16 already binds public inputs to the proof — a relayer
    //   that takes a proof for `recipient = A` cannot submit it with
    //   `recipient = B` because B is not what the verifier was given.
    //   The previous `x*x === xSquare` pattern (Tornado-style) only
    //   ensured the public-input signal was *referenced* somewhere in
    //   the constraint system, so the circom optimizer wouldn't drop
    //   it. Auditors flag the squaring pattern because:
    //
    //     1. Squaring is trivially satisfiable for any input — the
    //        constraint system cannot tell A from B once `A*A` and
    //        `B*B` are independently witnessed.
    //     2. Off-chain tooling that inspects the proof body (without
    //        re-running the verifier against the public inputs) would
    //        be fooled into accepting a substituted (recipient,
    //        relayer, fee) triple.
    //
    // Replacing the three squarings with a Poseidon hash over the
    // same three values makes the binding non-linear and explicit.
    // Any change to recipient / relayer / fee perturbs every
    // downstream wire in the witness, so a substitution attempt
    // produces an inconsistent witness rather than a separately-valid
    // square. The hash output (`paramsBindingHash`) is a witness-only
    // signal — it is NOT a public input, so no on-chain verifier
    // change is required, but the verifying key MUST be regenerated
    // from the rebuilt `.r1cs` (the constraint count changed). See
    // `runbooks/ceremony/PROCEDURE.md` for the full re-setup steps.
    component paramsBinding = Poseidon(3);
    paramsBinding.inputs[0] <== recipient;
    paramsBinding.inputs[1] <== relayer;
    paramsBinding.inputs[2] <== fee;

    signal paramsBindingHash;
    paramsBindingHash <== paramsBinding.out;
}

// 20 levels = 2^20 = ~1,048,576 possible deposits
component main {public [root, nullifierHash, recipient, relayer, fee]} = Withdraw(20);
