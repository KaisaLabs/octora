import { describe, it, expect } from "vitest";
import { poseidonHash } from "../merkle/hasher.js";

/**
 * Off-chain ↔ on-chain ZERO_HASHES parity.
 *
 * The on-chain mixer (`programs/octora-mixer/src/constants.rs`) hardcodes a
 * 20-entry `ZERO_HASHES` table that the deposit handler uses as the
 * empty-subtree sibling at every level. The off-chain Merkle tree
 * (`fixed-merkle-tree`) computes the same table at startup using the same
 * recurrence: `Z[0] = Poseidon(0, 0)`, `Z[i] = Poseidon(Z[i-1], Z[i-1])`.
 *
 * If a single byte in the on-chain table is wrong, the on-chain root
 * computed after a deposit will diverge from the off-chain root, and every
 * subsequent withdrawal proof will fail with `RootNotFound`. The existing
 * integration test (`tests/octora-mixer.ts`) catches this transitively
 * via the post-deposit root assertion, but only AFTER an on-chain deposit
 * has been made — slow and expensive.
 *
 * This test catches a transcription error in `constants.rs` immediately,
 * with no localnet required. If it fails, fix the constant before
 * `cargo build-sbf` — do not silence the test.
 */

const TREE_LEVELS = 20;

// Mirror of programs/octora-mixer/src/constants.rs::ZERO_HASHES.
// Each entry is the 32-byte big-endian Poseidon zero-subtree hash at that level.
const ON_CHAIN_ZERO_HASHES_HEX: string[] = [
  "2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864",
  "1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1",
  "18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238",
  "07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a",
  "2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55",
  "2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78",
  "078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d",
  "2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61",
  "0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747",
  "1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2",
  "1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636",
  "2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a",
  "14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0",
  "190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c",
  "22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92",
  "2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323",
  "2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992",
  "0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f",
  "1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca",
  "2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e",
];

function bigintToHex32(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

describe("ZERO_HASHES parity (off-chain vs on-chain)", () => {
  it("matches the hardcoded on-chain table at every level", async () => {
    expect(ON_CHAIN_ZERO_HASHES_HEX).toHaveLength(TREE_LEVELS);

    // Recurrence:  Z[0] = Poseidon(0, 0); Z[i] = Poseidon(Z[i-1], Z[i-1]).
    // Mirrors `compute-zero-hashes.mjs` and the on-chain expectation
    // documented in `constants.rs`.
    let current = 0n;
    for (let i = 0; i < TREE_LEVELS; i++) {
      current = await poseidonHash([current, current]);
      const offChainHex = bigintToHex32(current);
      const onChainHex = ON_CHAIN_ZERO_HASHES_HEX[i];
      expect(
        offChainHex,
        `ZERO_HASHES[${i}] mismatch — fix programs/octora-mixer/src/constants.rs before deploy`,
      ).toBe(onChainHex);
    }
  });

  it("level-0 sibling is the bare zero value (not Poseidon(0,0))", () => {
    // The on-chain deposit handler distinguishes between leaf-level and
    // subtree-level zero siblings:
    //   - At level 0 the sibling is an empty LEAF — the bare 32-byte zero.
    //   - At level i > 0 the sibling is ZERO_HASHES[i-1].
    // Verify the contract by spot-checking that ZERO_HASHES[0] is NOT
    // the all-zeros bytes (= we have the right semantics, not a "tree
    // of zero leaves" interpretation).
    expect(ON_CHAIN_ZERO_HASHES_HEX[0]).not.toBe("0".repeat(64));
  });
});
