import { buildPoseidon, type PoseidonFunction } from "circomlibjs";

// circomlibjs's `buildPoseidon` returns the BN254 / x^5 S-box variant —
// the same parameters Solana's Poseidon syscall uses when invoked with
// `Parameters::Bn254X5`. Big-endian byte order on both sides (we go
// through BigInt as the canonical representation, so encoding only
// matters when we serialize to bytes for the on-chain ix). If circomlibjs
// ever changes its default parameters, every hash this module produces
// will silently diverge from the on-chain syscall — so the
// `tests/octora-mixer.ts` integration test (which asserts off-chain
// root === on-chain root post-deposit) is the canary that catches that.

let poseidonInstance: PoseidonFunction | null = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Hash arbitrary bigint inputs with Poseidon (BN254, t = arity, x^5 S-box).
 *
 * @returns a bigint guaranteed to be a valid BN254 scalar field element
 *   (`< r`). Poseidon's range is the field, so callers don't need to
 *   reduce the output further before using it as another field input.
 */
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
