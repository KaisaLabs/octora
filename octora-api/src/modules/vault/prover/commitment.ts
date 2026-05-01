import { randomBytes } from "node:crypto";
import { poseidonHash } from "../merkle/hasher.js";
import type { VaultMerkleTree } from "../merkle/merkle-tree.js";

export interface Commitment {
  secret: bigint;
  nullifier: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

export interface WithdrawProofInputs {
  [signal: string]: string | string[] | number[];
  // Public
  root: string;
  nullifierHash: string;
  recipient: string;
  relayer: string;
  fee: string;
  // Private
  secret: string;
  nullifier: string;
  pathElements: string[];
  pathIndices: number[];
}

/** Generate a random field element (31 bytes to stay within BN128 scalar field). */
function randomFieldElement(): bigint {
  const bytes = randomBytes(31);
  return BigInt("0x" + bytes.toString("hex"));
}

/**
 * Generate a fresh commitment for a vault deposit.
 * Returns the secret, nullifier, commitment hash, and nullifier hash.
 */
export async function generateCommitment(): Promise<Commitment> {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();

  const commitment = await poseidonHash([secret, nullifier]);
  const nullifierHash = await poseidonHash([nullifier]);

  return { secret, nullifier, commitment, nullifierHash };
}

/**
 * Assemble the full input object for snarkjs Groth16 proof generation.
 * Call this after the commitment has been inserted into the Merkle tree.
 */
export function generateProofInputs(
  tree: VaultMerkleTree,
  leafIndex: number,
  secret: bigint,
  nullifier: bigint,
  nullifierHash: bigint,
  recipient: bigint,
  relayer: bigint,
  fee: bigint,
): WithdrawProofInputs {
  const { pathElements, pathIndices } = tree.getProof(leafIndex);

  return {
    root: tree.root().toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: recipient.toString(),
    relayer: relayer.toString(),
    fee: fee.toString(),
    secret: secret.toString(),
    nullifier: nullifier.toString(),
    pathElements,
    pathIndices,
  };
}
