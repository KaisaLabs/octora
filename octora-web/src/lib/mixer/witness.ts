// Deterministic Mixer Witness derivation (ADR-0001, v1).
//
// Derives a `(secret, nullifier, commitment, nullifierHash)` tuple for a
// single mixer leg (deposit or exit) from a signature over a frozen
// message, so the user can always re-derive the witness from their main
// wallet alone — no client-side persistence required.
//
// SHIPS DORMANT. Per the issue acceptance criteria, no production call
// site invokes `deriveMixerWitness` yet. The existing deposit-side flow
// (random `(secret, nullifier)` + `mixerWithdrawWitness` persistence in
// `commitment.ts`) is left untouched until a follow-up slice migrates
// it.
//
// See:
//   - ADR-0001 (../../../../../octora-programs/docs/adr/0001-mixer-witness-derivation.md)
//   - Issue KaisaLabs/octora-programs#2

import { sha256 } from "@noble/hashes/sha256";

import { poseidonHash } from "./poseidon";

/**
 * The two valid legs of a mixer position. `deposit` covers the
 * commitment that gates the stealth wallet's funds at deposit time;
 * `exit` covers the commitment for the symmetric private exit edge.
 *
 * Per ADR-0001 "Negative / load-bearing": this set must never be
 * silently widened. Any new leg (e.g. `compound`, `claim`) must be
 * introduced through a new ADR + glossary entry, not by appending a
 * string here.
 */
export type WitnessLeg = "deposit" | "exit";

/**
 * BN254 scalar field order. All four returned bigints are < `BN254_FR`.
 */
export const BN254_FR = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/**
 * The v1 derivation message template. **FROZEN for the program's
 * lifetime.**
 *
 * Any whitespace, capitalisation, or punctuation change here re-binds
 * every existing user's funds to a new derivation. Treat this string as
 * part of the on-chain program ABI.
 *
 * Adding a v2 message format requires a new exported function
 * (e.g. `deriveMixerWitnessV2`) — not editing this constant. The v1
 * function must continue to produce v1-derived witnesses indefinitely
 * so users with legacy commitments can always reach their funds.
 *
 * Placeholders (`<...>`) are replaced verbatim by `buildV1Message`.
 */
export const MIXER_WITNESS_V1_MESSAGE_TEMPLATE =
  "Octora · MixerWitness\n" +
  "Version: 1\n" +
  "Stealth: <stealth_pubkey_base58>\n" +
  "Position: <positionId_uuid>\n" +
  "Leg: <leg>\n" +
  "Attempt: <attempt>\n" +
  "\n" +
  "This signature derives the secret and nullifier for THIS mixer leg.\n" +
  "It does not authorize any on-chain transaction or token transfer.\n";

export interface DeriveMixerWitnessArgs {
  /** Stealth wallet pubkey, base58-encoded. Goes into the message verbatim. */
  stealthPubkey: string;
  /** Position UUID. Goes into the message verbatim. */
  positionId: string;
  /** Which side of the mixer flow this witness gates. */
  leg: WitnessLeg;
  /**
   * Non-negative integer. Bumping `attempt` lets a stuck Commitment be
   * retired without abandoning the Position (ADR-0001 "Consequences /
   * Positive"). Must be persisted server-side under `StoredPosition`
   * so a fresh device sees the same next-attempt number.
   */
  attempt: number;
  /**
   * Deterministic Ed25519 signer over the UTF-8 message bytes. In
   * production this is wired to the wallet adapter's `signMessage`;
   * in tests it's a fixed keypair from `@noble/curves/ed25519`.
   *
   * MUST return exactly the 64-byte raw Ed25519 signature (R || s).
   * Ed25519 is deterministic by construction, so the same keypair +
   * same message yields byte-identical output every time.
   */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface MixerWitness {
  /** Field element. Knowledge of `secret` is required to spend. */
  secret: bigint;
  /** Field element. Hashed once for the on-chain nullifier. */
  nullifier: bigint;
  /** Poseidon(secret, nullifier). Published on-chain at deposit time. */
  commitment: bigint;
  /** Poseidon(nullifier). Published on-chain at withdrawal time. */
  nullifierHash: bigint;
}

/**
 * Build the exact UTF-8 message bytes a wallet must sign for v1
 * derivation.
 *
 * Exported (rather than inlined into `deriveMixerWitness`) so callers
 * showing the message to the user — e.g. a wallet popup preview —
 * render byte-for-byte the same string we will hand to `signMessage`.
 */
export function buildV1Message(args: {
  stealthPubkey: string;
  positionId: string;
  leg: WitnessLeg;
  attempt: number;
}): string {
  if (!Number.isInteger(args.attempt) || args.attempt < 0) {
    throw new Error(
      `deriveMixerWitness: attempt must be a non-negative integer, got ${args.attempt}`,
    );
  }
  if (args.leg !== "deposit" && args.leg !== "exit") {
    // TypeScript would catch this, but runtime guard the v1 invariant
    // because silently widening Leg breaks domain separation.
    throw new Error(
      `deriveMixerWitness: invalid leg ${JSON.stringify(args.leg)}; expected 'deposit' | 'exit'`,
    );
  }
  return MIXER_WITNESS_V1_MESSAGE_TEMPLATE
    .replace("<stealth_pubkey_base58>", args.stealthPubkey)
    .replace("<positionId_uuid>", args.positionId)
    .replace("<leg>", args.leg)
    .replace("<attempt>", String(args.attempt));
}

/**
 * Interpret 32 bytes as a big-endian unsigned integer and reduce mod
 * the BN254 scalar field `Fr`. Bias ≈ 2⁻²⁵³ — negligible.
 *
 * Matches `ffjavascript`'s `Scalar.mod(Scalar.fromRprBE(bytes, 0, 32), Fr)`
 * byte-for-byte; the field-reduction acceptance test pins that
 * equivalence.
 */
export function bytesToFr(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(
      `bytesToFr: expected 32 bytes, got ${bytes.length}`,
    );
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex) % BN254_FR;
}

/**
 * Concatenate a 64-byte signature and a single domain-separator byte
 * into a 65-byte buffer suitable for SHA-256.
 *
 * The domain separator (`0x01` for `secret`, `0x02` for `nullifier`)
 * ensures `secret` and `nullifier` are independent random oracles
 * even given the same signature — ADR-0001.
 */
function concatSigDomain(sig: Uint8Array, domain: number): Uint8Array {
  const out = new Uint8Array(sig.length + 1);
  out.set(sig, 0);
  out[sig.length] = domain;
  return out;
}

/**
 * Derive the deterministic v1 mixer witness for a single leg.
 *
 * Determinism guarantee: Ed25519 signatures are deterministic
 * (RFC 8032), SHA-256 is deterministic, integer reduction is
 * deterministic, and Poseidon over `BN254_FR` is deterministic — so
 * for any fixed `(stealthPubkey, positionId, leg, attempt, signing key)`
 * the returned tuple is byte-identical across browsers, Node, and
 * future re-derivations.
 *
 * Domain separation: changing only `leg` between two calls (with all
 * other inputs identical) produces a different signed message, hence
 * a different signature, hence independent `(secret, nullifier)`
 * pairs. The `0x01`/`0x02` domain bytes additionally guarantee
 * `secret` ≠ `nullifier` even for the same `leg`.
 */
export async function deriveMixerWitness(
  args: DeriveMixerWitnessArgs,
): Promise<MixerWitness> {
  const message = buildV1Message({
    stealthPubkey: args.stealthPubkey,
    positionId: args.positionId,
    leg: args.leg,
    attempt: args.attempt,
  });
  const messageBytes = new TextEncoder().encode(message);

  const sig = await args.signMessage(messageBytes);
  if (sig.length !== 64) {
    throw new Error(
      `deriveMixerWitness: expected 64-byte Ed25519 signature, got ${sig.length}`,
    );
  }

  const secret = bytesToFr(sha256(concatSigDomain(sig, 0x01)));
  const nullifier = bytesToFr(sha256(concatSigDomain(sig, 0x02)));

  const [commitment, nullifierHash] = await Promise.all([
    poseidonHash([secret, nullifier]),
    poseidonHash([nullifier]),
  ]);

  return { secret, nullifier, commitment, nullifierHash };
}
