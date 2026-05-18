/**
 * Tests for the deterministic Mixer Witness derivation (ADR-0001, v1).
 *
 * The four pinned invariants from the issue acceptance criteria:
 *   1. Determinism — same inputs → byte-identical output.
 *   2. Domain separation — only `Leg` differs → independent
 *      `(secret, nullifier)`.
 *   3. Field reduction matches `ffjavascript`'s
 *      `Scalar.fromRprBE` + mod Fr.
 *   4. Frozen v1 message template — any edit re-binds every user's
 *      funds, so we snapshot the byte-exact template + a rendered
 *      example.
 *
 * Determinism in tests comes from Ed25519 itself (RFC 8032) given a
 * fixed keypair, so we don't need network or wallet mocks.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
// `ffjavascript` is a transitive dependency (via `circomlibjs`/`snarkjs`).
// It ships no types, so we declare just the surface we use in this test.
// Used only as an INDEPENDENT reference implementation of big-endian → Fr
// reduction for the acceptance criterion in issue #2.
// @ts-expect-error -- ffjavascript has no published .d.ts
import { Scalar } from "ffjavascript";
import { describe, expect, it } from "vitest";

import {
  BN254_FR,
  MIXER_WITNESS_V1_MESSAGE_TEMPLATE,
  buildV1Message,
  bytesToFr,
  deriveMixerWitness,
} from "../witness";

// Fixed 32-byte seed — value is arbitrary but FROZEN so the test
// vectors below are reproducible across CI runs and developer
// machines.
const FIXED_SEED = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
  0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

function makeSigner(seed: Uint8Array = FIXED_SEED) {
  return async (msg: Uint8Array): Promise<Uint8Array> => ed25519.sign(msg, seed);
}

const FIXED_INPUTS = {
  stealthPubkey: "11111111111111111111111111111111",
  positionId: "00000000-0000-0000-0000-000000000001",
  leg: "deposit" as const,
  attempt: 0,
};

describe("MIXER_WITNESS_V1_MESSAGE_TEMPLATE (frozen)", () => {
  // If this snapshot test ever fails: STOP. The v1 string is part of
  // the program ABI. A change here re-binds every user's funds to a
  // new derivation. Adding a v2 format requires a new exported
  // function, not editing v1.
  it("matches the exact ADR-0001 template, byte-for-byte", () => {
    const expected =
      "Octora · MixerWitness\n" +
      "Version: 1\n" +
      "Stealth: <stealth_pubkey_base58>\n" +
      "Position: <positionId_uuid>\n" +
      "Leg: <leg>\n" +
      "Attempt: <attempt>\n" +
      "\n" +
      "This signature derives the secret and nullifier for THIS mixer leg.\n" +
      "It does not authorize any on-chain transaction or token transfer.\n";
    expect(MIXER_WITNESS_V1_MESSAGE_TEMPLATE).toBe(expected);
  });

  it("renders a known fixture deterministically", () => {
    expect(buildV1Message(FIXED_INPUTS)).toBe(
      "Octora · MixerWitness\n" +
        "Version: 1\n" +
        "Stealth: 11111111111111111111111111111111\n" +
        "Position: 00000000-0000-0000-0000-000000000001\n" +
        "Leg: deposit\n" +
        "Attempt: 0\n" +
        "\n" +
        "This signature derives the secret and nullifier for THIS mixer leg.\n" +
        "It does not authorize any on-chain transaction or token transfer.\n",
    );
  });

  it("rejects negative or non-integer attempt", () => {
    expect(() => buildV1Message({ ...FIXED_INPUTS, attempt: -1 })).toThrow();
    expect(() => buildV1Message({ ...FIXED_INPUTS, attempt: 1.5 })).toThrow();
  });

  it("rejects unknown leg at runtime (defence in depth)", () => {
    expect(() =>
      buildV1Message({
        ...FIXED_INPUTS,
        // Force-cast to exercise the runtime guard — TypeScript would
        // normally catch this at the call site.
        leg: "compound" as unknown as "deposit",
      }),
    ).toThrow();
  });
});

describe("bytesToFr (field reduction)", () => {
  it("matches ffjavascript Scalar.fromRprBE mod Fr for a deterministic vector", () => {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = (i * 37 + 11) & 0xff;
    const ours = bytesToFr(buf);
    const ref = Scalar.mod(Scalar.fromRprBE(buf, 0, 32), BN254_FR);
    expect(ours.toString()).toBe(ref.toString());
  });

  it("matches ffjavascript across many random vectors", () => {
    for (let i = 0; i < 32; i++) {
      const buf = sha256(new Uint8Array([i]));
      const ours = bytesToFr(buf);
      const ref = Scalar.mod(Scalar.fromRprBE(buf, 0, 32), BN254_FR);
      expect(ours.toString()).toBe(ref.toString());
    }
  });

  it("reduces an above-Fr value correctly (all 0xff bytes)", () => {
    const buf = new Uint8Array(32).fill(0xff);
    const ours = bytesToFr(buf);
    const ref = Scalar.mod(Scalar.fromRprBE(buf, 0, 32), BN254_FR);
    expect(ours.toString()).toBe(ref.toString());
    expect(ours < BN254_FR).toBe(true);
  });
});

describe("deriveMixerWitness (v1, dormant)", () => {
  it("is deterministic across two separate calls", async () => {
    const sign = makeSigner();
    const a = await deriveMixerWitness({ ...FIXED_INPUTS, signMessage: sign });
    const b = await deriveMixerWitness({ ...FIXED_INPUTS, signMessage: sign });
    expect(a.secret.toString()).toBe(b.secret.toString());
    expect(a.nullifier.toString()).toBe(b.nullifier.toString());
    expect(a.commitment.toString()).toBe(b.commitment.toString());
    expect(a.nullifierHash.toString()).toBe(b.nullifierHash.toString());
  });

  it("outputs are all in [0, BN254_FR)", async () => {
    const sign = makeSigner();
    const w = await deriveMixerWitness({ ...FIXED_INPUTS, signMessage: sign });
    expect(w.secret >= 0n && w.secret < BN254_FR).toBe(true);
    expect(w.nullifier >= 0n && w.nullifier < BN254_FR).toBe(true);
    expect(w.commitment >= 0n && w.commitment < BN254_FR).toBe(true);
    expect(w.nullifierHash >= 0n && w.nullifierHash < BN254_FR).toBe(true);
  });

  it("yields independent (secret, nullifier) when only Leg differs", async () => {
    const sign = makeSigner();
    const deposit = await deriveMixerWitness({
      ...FIXED_INPUTS,
      leg: "deposit",
      signMessage: sign,
    });
    const exit = await deriveMixerWitness({
      ...FIXED_INPUTS,
      leg: "exit",
      signMessage: sign,
    });
    // Fully independent — neither secret nor nullifier may collide.
    expect(deposit.secret).not.toBe(exit.secret);
    expect(deposit.nullifier).not.toBe(exit.nullifier);
    expect(deposit.commitment).not.toBe(exit.commitment);
    expect(deposit.nullifierHash).not.toBe(exit.nullifierHash);
    // Cross-checks: deposit.secret must not equal exit.nullifier and
    // vice versa — the 0x01/0x02 domain bytes guarantee this within a
    // single leg, but the cross-leg check pins it explicitly.
    expect(deposit.secret).not.toBe(exit.nullifier);
    expect(deposit.nullifier).not.toBe(exit.secret);
  });

  it("yields different witnesses when only Attempt differs", async () => {
    const sign = makeSigner();
    const a0 = await deriveMixerWitness({
      ...FIXED_INPUTS,
      attempt: 0,
      signMessage: sign,
    });
    const a1 = await deriveMixerWitness({
      ...FIXED_INPUTS,
      attempt: 1,
      signMessage: sign,
    });
    expect(a0.commitment).not.toBe(a1.commitment);
    expect(a0.nullifierHash).not.toBe(a1.nullifierHash);
  });

  it("yields different witnesses when only Position differs", async () => {
    const sign = makeSigner();
    const p0 = await deriveMixerWitness({
      ...FIXED_INPUTS,
      positionId: "00000000-0000-0000-0000-000000000001",
      signMessage: sign,
    });
    const p1 = await deriveMixerWitness({
      ...FIXED_INPUTS,
      positionId: "00000000-0000-0000-0000-000000000002",
      signMessage: sign,
    });
    expect(p0.commitment).not.toBe(p1.commitment);
    expect(p0.nullifierHash).not.toBe(p1.nullifierHash);
  });

  it("secret and nullifier are independent for a single leg (domain separators 0x01/0x02)", async () => {
    const sign = makeSigner();
    const w = await deriveMixerWitness({ ...FIXED_INPUTS, signMessage: sign });
    expect(w.secret).not.toBe(w.nullifier);
  });

  it("rejects a signer that returns the wrong signature length", async () => {
    const badSigner = async () => new Uint8Array(63);
    await expect(
      deriveMixerWitness({ ...FIXED_INPUTS, signMessage: badSigner }),
    ).rejects.toThrow(/64-byte/);
  });

  it("matches a hand-computed reference (secret, nullifier) from the same primitives", async () => {
    // Pin the SHA-256 || 0x01 / || 0x02 reduction independently of the
    // production implementation: re-do it with stock noble primitives
    // and ffjavascript, then check `deriveMixerWitness` arrives at the
    // same `secret` / `nullifier`.
    const sign = makeSigner();
    const msg = new TextEncoder().encode(buildV1Message(FIXED_INPUTS));
    const sig = await sign(msg);
    const refSecretBytes = sha256(
      new Uint8Array([...sig, 0x01]),
    );
    const refNullifierBytes = sha256(
      new Uint8Array([...sig, 0x02]),
    );
    const refSecret = Scalar.mod(
      Scalar.fromRprBE(refSecretBytes, 0, 32),
      BN254_FR,
    );
    const refNullifier = Scalar.mod(
      Scalar.fromRprBE(refNullifierBytes, 0, 32),
      BN254_FR,
    );

    const w = await deriveMixerWitness({ ...FIXED_INPUTS, signMessage: sign });
    expect(w.secret.toString()).toBe(refSecret.toString());
    expect(w.nullifier.toString()).toBe(refNullifier.toString());
  });
});
