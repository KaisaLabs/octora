// Browser-side commitment generation.
//
// Critical security note: this MUST run in the user's browser. The secret
// and nullifier are the only things between the user and an attacker who
// can withdraw their deposit. They must never be sent over the network.

import { poseidonHash } from "./poseidon";

export interface Commitment {
  /** Random field element. Knowledge of `secret` is required to withdraw. */
  secret: bigint;
  /** Random field element. Hashed once for the on-chain nullifier. */
  nullifier: bigint;
  /** Poseidon(secret, nullifier) — published on-chain at deposit. */
  commitment: bigint;
  /** Poseidon(nullifier) — published on-chain at withdrawal to mark spend. */
  nullifierHash: bigint;
}

/**
 * Generate a uniformly random 31-byte BN254 field element using the
 * platform CSPRNG. 31 bytes (248 bits) stays comfortably below the
 * BN254 scalar field order (~254 bits) so we never need to rejection-sample.
 */
function randomFieldElement(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

/** Generate a fresh deposit commitment in the browser. */
export async function generateCommitment(): Promise<Commitment> {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  const [commitment, nullifierHash] = await Promise.all([
    poseidonHash([secret, nullifier]),
    poseidonHash([nullifier]),
  ]);
  return { secret, nullifier, commitment, nullifierHash };
}
