// Browser-side packers for the on-chain mixer instruction layout.
// Mirrors octora-api/src/modules/relayer/proof-converter.ts so the bytes
// landing on-chain are identical regardless of where they were built.

import { PublicKey } from "@solana/web3.js";

// BN254 base field prime p (used to negate G1 point's y coordinate)
const BN254_P = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

// BN254 scalar field order r
const BN254_R = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

function bigintToBeBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Convert a snarkjs Groth16 proof to the 256-byte packed format the on-chain
 * verifier expects (pi_a 64 || pi_b 128 || pi_c 64). pi_a's y-coordinate is
 * pre-negated client-side per groth16-solana's calling convention.
 */
export function convertProofToBytes(proof: Groth16Proof): Uint8Array {
  const buf = new Uint8Array(256);

  const piAx = bigintToBeBytes(BigInt(proof.pi_a[0]));
  const piAyNeg = bigintToBeBytes(BN254_P - BigInt(proof.pi_a[1]));
  buf.set(piAx, 0);
  buf.set(piAyNeg, 32);

  const piBx1 = bigintToBeBytes(BigInt(proof.pi_b[0][1]));
  const piBx0 = bigintToBeBytes(BigInt(proof.pi_b[0][0]));
  const piBy1 = bigintToBeBytes(BigInt(proof.pi_b[1][1]));
  const piBy0 = bigintToBeBytes(BigInt(proof.pi_b[1][0]));
  buf.set(piBx1, 64);
  buf.set(piBx0, 96);
  buf.set(piBy1, 128);
  buf.set(piBy0, 160);

  const piCx = bigintToBeBytes(BigInt(proof.pi_c[0]));
  const piCy = bigintToBeBytes(BigInt(proof.pi_c[1]));
  buf.set(piCx, 192);
  buf.set(piCy, 224);

  return buf;
}

/**
 * Pack the 5 publicSignals into the 160-byte layout the on-chain program parses:
 *   root (32) || nullifierHash (32) || recipient (32) || relayer (32) || fee (32)
 */
export function convertPublicInputsToBytes(publicSignals: string[]): Uint8Array {
  if (publicSignals.length !== 5) {
    throw new Error(`Expected 5 public signals, got ${publicSignals.length}`);
  }
  const buf = new Uint8Array(160);
  for (let i = 0; i < 5; i++) {
    buf.set(bigintToBeBytes(BigInt(publicSignals[i])), i * 32);
  }
  return buf;
}

/** Raw 256-bit pubkey as bigint (matches off-chain semantics in the relayer). */
export function pubkeyToFieldElement(pubkey: PublicKey): bigint {
  let hex = "0x";
  for (const b of pubkey.toBytes()) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

/**
 * Reduce a Solana pubkey mod the BN254 scalar field order.
 * This matches both the on-chain `pubkey_to_field_element` and the value
 * the circuit auto-reduces inputs to, so it's the canonical form for proof
 * inputs and on-chain comparison.
 */
export function pubkeyToReducedField(pubkey: PublicKey): bigint {
  return pubkeyToFieldElement(pubkey) % BN254_R;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
