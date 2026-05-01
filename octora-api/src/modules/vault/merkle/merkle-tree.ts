import MerkleTree from "fixed-merkle-tree";
import { createPoseidonHasher } from "./hasher.js";

export const TREE_LEVELS = 20;
const ZERO_VALUE = "0";

export interface MerkleProof {
  pathElements: string[];
  pathIndices: number[];
}

export interface VaultMerkleTree {
  insert(commitment: bigint): number;
  getProof(leafIndex: number): MerkleProof;
  root(): bigint;
  indexOf(commitment: bigint): number;
  elements(): string[];
}

/**
 * Creates a Poseidon-based fixed Merkle tree for the vault mixer.
 * 20 levels = 2^20 = ~1M possible deposits.
 */
export async function createVaultMerkleTree(
  levels: number = TREE_LEVELS,
  existingLeaves: bigint[] = [],
): Promise<VaultMerkleTree> {
  const { hash } = await createPoseidonHasher();

  const tree = new MerkleTree(levels, existingLeaves.map(String), {
    hashFunction: hash as (left: string | number, right: string | number) => string,
    zeroElement: ZERO_VALUE,
  });

  return {
    insert(commitment: bigint): number {
      tree.insert(String(commitment));
      return tree.elements.length - 1;
    },

    getProof(leafIndex: number): MerkleProof {
      const { pathElements, pathIndices } = tree.path(leafIndex);
      return {
        pathElements: pathElements.map(String),
        pathIndices: pathIndices,
      };
    },

    root(): bigint {
      return BigInt(tree.root);
    },

    indexOf(commitment: bigint): number {
      return tree.indexOf(String(commitment));
    },

    elements(): string[] {
      return tree.elements.map(String);
    },
  };
}
