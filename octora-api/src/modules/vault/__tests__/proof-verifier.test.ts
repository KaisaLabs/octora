import { describe, it, expect } from "vitest";
import { createVaultMerkleTree } from "../merkle/merkle-tree.js";
import { generateCommitment, generateProofInputs } from "../prover/commitment.js";
import {
  circuitArtifactsExist,
  generateWithdrawProof,
  verifyWithdrawProof,
} from "../prover/proof-verifier.js";

describe("proof generation and verification (requires circuit artifacts)", () => {
  it("generates and verifies a valid withdrawal proof", async () => {
    const hasArtifacts = await circuitArtifactsExist();
    if (!hasArtifacts) {
      console.log(
        "Skipping proof test — circuit artifacts not found.\n" +
        "Run: bash src/modules/vault/circuits/setup.sh",
      );
      return;
    }

    // 1. Generate commitment
    const { secret, nullifier, commitment, nullifierHash } = await generateCommitment();

    // 2. Insert into Merkle tree
    const tree = await createVaultMerkleTree(20);
    const leafIndex = tree.insert(commitment);

    // 3. Build proof inputs
    const recipient = 123456789n;
    const relayer = 987654321n;
    const fee = 10000n;

    const inputs = generateProofInputs(
      tree, leafIndex, secret, nullifier, nullifierHash,
      recipient, relayer, fee,
    );

    // 4. Generate proof
    const { proof, publicSignals } = await generateWithdrawProof(inputs);

    expect(proof).toBeDefined();
    expect(publicSignals).toBeDefined();
    expect(publicSignals.length).toBeGreaterThan(0);

    // 5. Verify proof
    const isValid = await verifyWithdrawProof(proof, publicSignals);
    expect(isValid).toBe(true);
  }, 120_000); // circuit proving can be slow

  it("rejects a proof with tampered public signals", async () => {
    const hasArtifacts = await circuitArtifactsExist();
    if (!hasArtifacts) return;

    const { secret, nullifier, commitment, nullifierHash } = await generateCommitment();
    const tree = await createVaultMerkleTree(20);
    const leafIndex = tree.insert(commitment);

    const inputs = generateProofInputs(
      tree, leafIndex, secret, nullifier, nullifierHash,
      123456789n, 987654321n, 10000n,
    );

    const { proof, publicSignals } = await generateWithdrawProof(inputs);

    // Tamper with the recipient (public signal)
    const tampered = [...publicSignals];
    tampered[2] = "999999999";

    const isValid = await verifyWithdrawProof(proof, tampered);
    expect(isValid).toBe(false);
  }, 120_000);
});
