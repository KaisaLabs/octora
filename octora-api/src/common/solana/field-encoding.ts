/**
 * Solana PDA / BN254 field-element encoding utilities.
 *
 * Lives in `common/solana/` because both the mixer module (deposit /
 * withdraw / nullifier PDAs) and the relayer (nullifier PDA derivation
 * during proof submission) need it. Previously housed on
 * `MixerService`, which forced the relayer to import a util from a
 * sibling feature module — that's the coupling the architecture review
 * called out for inversion.
 */
import { ValidationError } from "#common/errors";

/**
 * Thrown when a bigint value can't fit into a 32-byte big-endian PDA
 * seed. Catching this at the seam keeps Solana's findProgramAddressSync
 * from surfacing a cryptic "Max seed length exceeded" 500 deeper in
 * the stack.
 */
export class SeedRangeError extends ValidationError {
  constructor(public readonly field: string, public readonly value: bigint) {
    super(`${field} value too large to fit in 32-byte PDA seed: ${value.toString()}`, {
      code: "seed_range",
      details: { field, value: value.toString() },
    });
    this.name = "SeedRangeError";
  }
}

/**
 * Pack a bigint into exactly 32 big-endian bytes. Throws SeedRangeError
 * if the value doesn't fit (≥ 2^256 or negative).
 */
export function bigintToBytes32(value: bigint, field: string): Buffer {
  if (value < 0n || value >= 1n << 256n) {
    throw new SeedRangeError(field, value);
  }
  const out = Buffer.alloc(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
