import { describe, it, expect, beforeAll } from "vitest";
import { poseidonHash, poseidonHash2 } from "../merkle/hasher.js";
import { createVaultMerkleTree } from "../merkle/merkle-tree.js";
import { generateCommitment, generateProofInputs } from "../prover/commitment.js";

describe("poseidon hasher", () => {
  it("hashes two inputs deterministically", async () => {
    const a = 1n;
    const b = 2n;

    const hash1 = await poseidonHash([a, b]);
    const hash2 = await poseidonHash([a, b]);

    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("bigint");
    expect(hash1).toBeGreaterThan(0n);
  });

  it("produces different hashes for different inputs", async () => {
    const h1 = await poseidonHash([1n, 2n]);
    const h2 = await poseidonHash([2n, 1n]);
    const h3 = await poseidonHash([1n, 3n]);

    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("poseidonHash2 matches poseidonHash with 2 inputs", async () => {
    const a = 12345n;
    const b = 67890n;

    const h1 = await poseidonHash([a, b]);
    const h2 = await poseidonHash2(a, b);

    expect(h1).toBe(h2);
  });

  it("hashes single input (for nullifier hash)", async () => {
    const nullifier = 42n;
    const hash = await poseidonHash([nullifier]);

    expect(typeof hash).toBe("bigint");
    expect(hash).toBeGreaterThan(0n);
  });
});

describe("vault merkle tree", () => {
  it("creates a tree with the correct default root", async () => {
    const tree = await createVaultMerkleTree(20);
    const root = tree.root();

    expect(typeof root).toBe("bigint");
    expect(root).toBeGreaterThan(0n);
  });

  it("inserts a commitment and returns the leaf index", async () => {
    const tree = await createVaultMerkleTree(20);
    const commitment = await poseidonHash([100n, 200n]);

    const index = tree.insert(commitment);

    expect(index).toBe(0);
  });

  it("root changes after insert", async () => {
    const tree = await createVaultMerkleTree(20);
    const rootBefore = tree.root();

    const commitment = await poseidonHash([100n, 200n]);
    tree.insert(commitment);

    const rootAfter = tree.root();
    expect(rootAfter).not.toBe(rootBefore);
  });

  it("generates a valid merkle proof", async () => {
    const tree = await createVaultMerkleTree(20);
    const commitment = await poseidonHash([100n, 200n]);
    const index = tree.insert(commitment);

    const proof = tree.getProof(index);

    expect(proof.pathElements).toHaveLength(20);
    expect(proof.pathIndices).toHaveLength(20);
    // First leaf goes left at every level
    expect(proof.pathIndices[0]).toBe(0);
  });

  it("finds commitment by index", async () => {
    const tree = await createVaultMerkleTree(20);
    const c1 = await poseidonHash([1n, 2n]);
    const c2 = await poseidonHash([3n, 4n]);

    tree.insert(c1);
    tree.insert(c2);

    expect(tree.indexOf(c1)).toBe(0);
    expect(tree.indexOf(c2)).toBe(1);
  });

  it("handles multiple inserts with sequential indices", async () => {
    const tree = await createVaultMerkleTree(20);

    for (let i = 0; i < 5; i++) {
      const commitment = await poseidonHash([BigInt(i), BigInt(i + 100)]);
      const index = tree.insert(commitment);
      expect(index).toBe(i);
    }

    expect(tree.elements()).toHaveLength(5);
  });

  it("can be initialized with existing leaves", async () => {
    const c1 = await poseidonHash([1n, 2n]);
    const c2 = await poseidonHash([3n, 4n]);

    const tree = await createVaultMerkleTree(20, [c1, c2]);

    expect(tree.indexOf(c1)).toBe(0);
    expect(tree.indexOf(c2)).toBe(1);
    expect(tree.elements()).toHaveLength(2);
  });
});

describe("commitment generation", () => {
  it("generates a valid commitment with all fields", async () => {
    const result = await generateCommitment();

    expect(typeof result.secret).toBe("bigint");
    expect(typeof result.nullifier).toBe("bigint");
    expect(typeof result.commitment).toBe("bigint");
    expect(typeof result.nullifierHash).toBe("bigint");

    expect(result.secret).toBeGreaterThan(0n);
    expect(result.nullifier).toBeGreaterThan(0n);
    expect(result.commitment).toBeGreaterThan(0n);
    expect(result.nullifierHash).toBeGreaterThan(0n);
  });

  it("generates unique commitments each time", async () => {
    const c1 = await generateCommitment();
    const c2 = await generateCommitment();

    expect(c1.commitment).not.toBe(c2.commitment);
    expect(c1.secret).not.toBe(c2.secret);
    expect(c1.nullifier).not.toBe(c2.nullifier);
  });

  it("commitment matches Poseidon(secret, nullifier)", async () => {
    const result = await generateCommitment();
    const expectedCommitment = await poseidonHash([result.secret, result.nullifier]);
    const expectedNullifierHash = await poseidonHash([result.nullifier]);

    expect(result.commitment).toBe(expectedCommitment);
    expect(result.nullifierHash).toBe(expectedNullifierHash);
  });

  it("generates proof inputs with correct structure", async () => {
    const tree = await createVaultMerkleTree(20);
    const { secret, nullifier, commitment, nullifierHash } = await generateCommitment();

    const leafIndex = tree.insert(commitment);
    const recipient = 123456789n;
    const relayer = 987654321n;
    const fee = 10000n;

    const inputs = generateProofInputs(
      tree, leafIndex, secret, nullifier, nullifierHash,
      recipient, relayer, fee,
    );

    expect(inputs.root).toBe(tree.root().toString());
    expect(inputs.nullifierHash).toBe(nullifierHash.toString());
    expect(inputs.recipient).toBe(recipient.toString());
    expect(inputs.relayer).toBe(relayer.toString());
    expect(inputs.fee).toBe(fee.toString());
    expect(inputs.secret).toBe(secret.toString());
    expect(inputs.nullifier).toBe(nullifier.toString());
    expect(inputs.pathElements).toHaveLength(20);
    expect(inputs.pathIndices).toHaveLength(20);
  });
});
