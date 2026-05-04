import { PublicKey } from "@solana/web3.js";
import type { Groth16Proof } from "#modules/vault";

/**
 * Convert a snarkjs Groth16 proof to the packed byte format
 * expected by the on-chain mixer program.
 *
 * On-chain layout (256 bytes total):
 *   pi_a: 64 bytes (G1 point: x || y, big-endian)
 *   pi_b: 128 bytes (G2 point: x_c1 || x_c0 || y_c1 || y_c0, big-endian)
 *   pi_c: 64 bytes (G1 point: x || y, big-endian)
 */
// BN254 base field prime p (for G1 point negation)
const BN254_P = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

// BN254 scalar field order r (matches BN254_FIELD_ORDER in the on-chain program).
// Public signals coming back from snarkjs are always reduced mod r, so any
// off-chain comparison against them must reduce too.
const BN254_R = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

export function convertProofToBytes(proof: Groth16Proof): Buffer {
  const buf = Buffer.alloc(256);

  // pi_a: [x, y, "1"] — negate y for the pairing check (p - y)
  // groth16-solana expects pi_a already negated
  const piAx = bigintToBeBytes(BigInt(proof.pi_a[0]));
  const piAyRaw = BigInt(proof.pi_a[1]);
  const piAyNeg = bigintToBeBytes(BN254_P - piAyRaw);
  piAx.copy(buf, 0);
  piAyNeg.copy(buf, 32);

  // pi_b: [[x_c0, x_c1], [y_c0, y_c1], ["1", "0"]]
  // groth16-solana expects: x_c1 || x_c0 || y_c1 || y_c0 (reversed coefficient order)
  const piBx1 = bigintToBeBytes(BigInt(proof.pi_b[0][1]));
  const piBx0 = bigintToBeBytes(BigInt(proof.pi_b[0][0]));
  const piBy1 = bigintToBeBytes(BigInt(proof.pi_b[1][1]));
  const piBy0 = bigintToBeBytes(BigInt(proof.pi_b[1][0]));
  piBx1.copy(buf, 64);
  piBx0.copy(buf, 96);
  piBy1.copy(buf, 128);
  piBy0.copy(buf, 160);

  // pi_c: [x, y, "1"]
  const piCx = bigintToBeBytes(BigInt(proof.pi_c[0]));
  const piCy = bigintToBeBytes(BigInt(proof.pi_c[1]));
  piCx.copy(buf, 192);
  piCy.copy(buf, 224);

  return buf;
}

/**
 * Convert the 5 public signals to packed 160-byte format.
 *
 * Order: root (32) || nullifierHash (32) || recipient (32) || relayer (32) || fee (32)
 * Each signal is a BN254 field element as a 32-byte big-endian integer.
 */
export function convertPublicInputsToBytes(publicSignals: string[]): Buffer {
  if (publicSignals.length !== 5) {
    throw new Error(`Expected 5 public signals, got ${publicSignals.length}`);
  }

  const buf = Buffer.alloc(160);
  for (let i = 0; i < 5; i++) {
    const bytes = bigintToBeBytes(BigInt(publicSignals[i]));
    bytes.copy(buf, i * 32);
  }
  return buf;
}

/**
 * Convert a Solana PublicKey to a BN254 field element.
 *
 * Pubkeys are 32 bytes (256 bits). The BN254 scalar field is ~254 bits.
 * Most pubkeys (~94%) fit within the field. For the rest, we use the
 * raw bytes directly — the on-chain program does the same conversion.
 */
export function pubkeyToFieldElement(pubkey: PublicKey): bigint {
  return BigInt("0x" + Buffer.from(pubkey.toBytes()).toString("hex"));
}

/**
 * Convert a Solana PublicKey to its reduced BN254 field element.
 *
 * Equivalent to `pubkeyToFieldElement(pubkey) mod r`. This matches what the
 * circuit and the on-chain `pubkey_to_field_element` produce, and is the
 * value that ends up in publicSignals.
 */
export function pubkeyToReducedField(pubkey: PublicKey): bigint {
  return pubkeyToFieldElement(pubkey) % BN254_R;
}

/**
 * Convert a bigint to a 32-byte big-endian Buffer.
 */
function bigintToBeBytes(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}
