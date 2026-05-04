// Browser-side Poseidon hash via circomlibjs.
//
// This wrapper exists for two reasons:
//   1. circomlibjs builds Poseidon asynchronously (WASM init), so we cache
//      the instance to avoid repeated initialisation.
//   2. The library's types are loose, so we centralise the casts.
//
// Mirrors octora-api/src/modules/vault/merkle/hasher.ts but runs in the browser
// — the user must never have to send their secret/nullifier to a server.

import { buildPoseidon } from "circomlibjs";

type PoseidonFn = ((inputs: unknown[]) => Uint8Array) & {
  F: { e(v: bigint): unknown; toString(v: unknown): string };
};

let cached: Promise<PoseidonFn> | null = null;

async function getPoseidon(): Promise<PoseidonFn> {
  if (!cached) {
    cached = buildPoseidon() as Promise<PoseidonFn>;
  }
  return cached;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const out = poseidon(inputs.map((x) => poseidon.F.e(x)));
  return BigInt(poseidon.F.toString(out));
}

/**
 * Synchronous 2-input Poseidon hasher for fixed-merkle-tree.
 * Caller must `await initPoseidon()` first to ensure the WASM is loaded.
 */
export async function getPoseidonHasher() {
  const poseidon = await getPoseidon();
  return (left: string, right: string): string => {
    const out = poseidon([BigInt(left), BigInt(right)]);
    return poseidon.F.toString(out);
  };
}

/** Eagerly initialise Poseidon. Useful before building a tree. */
export async function initPoseidon(): Promise<void> {
  await getPoseidon();
}
