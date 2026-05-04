// Browser-side Poseidon Merkle tree, mirrors octora-api/.../merkle/merkle-tree.ts.
//
// The tree must be reconstructed in the browser from the public deposit
// history (commitments + leaf indices) so we can compute inclusion proofs
// without trusting a server with the user's leaf identity.

import { MerkleTree } from "fixed-merkle-tree";
import { getPoseidonHasher } from "./poseidon";

export const TREE_LEVELS = 20;
const ZERO_VALUE = "0";

export interface MerkleProof {
  pathElements: string[];
  pathIndices: number[];
}

export interface MixerMerkleTree {
  insert(commitment: bigint): number;
  getProof(leafIndex: number): MerkleProof;
  root(): bigint;
  indexOf(commitment: bigint): number;
  elements(): string[];
}

export async function createMixerMerkleTree(
  levels: number = TREE_LEVELS,
  existingLeaves: bigint[] = [],
): Promise<MixerMerkleTree> {
  const hash = await getPoseidonHasher();

  const tree = new MerkleTree(levels, existingLeaves.map(String), {
    hashFunction: hash as unknown as (
      left: string | number,
      right: string | number,
    ) => string,
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
        pathIndices,
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
