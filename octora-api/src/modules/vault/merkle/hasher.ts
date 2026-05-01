import { buildPoseidon, type PoseidonFunction } from "circomlibjs";

let poseidonInstance: PoseidonFunction | null = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/** Hash arbitrary bigint inputs with Poseidon. Returns a bigint. */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs.map((x) => poseidon.F.e(x)));
  return BigInt(poseidon.F.toString(hash));
}

/** Optimized 2-input Poseidon hash (used by the Merkle tree). */
export async function poseidonHash2(a: bigint, b: bigint): Promise<bigint> {
  return poseidonHash([a, b]);
}

/**
 * Returns a synchronous 2-input Poseidon hasher compatible with fixed-merkle-tree.
 * Must be called once (async) before building the tree.
 */
export async function createPoseidonHasher() {
  const poseidon = await getPoseidon();

  /** Sync hash for fixed-merkle-tree: takes two Element strings, returns a string. */
  function hash(left: string, right: string): string {
    const result = poseidon([BigInt(left), BigInt(right)]);
    return poseidon.F.toString(result);
  }

  return { hash, poseidon };
}
