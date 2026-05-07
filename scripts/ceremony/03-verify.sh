#!/usr/bin/env bash
#
# Phase-2 ceremony — STEP 3: independent verifier.
#
# Anyone (auditors, users, external researchers) can run this to verify
# the entire ceremony post-hoc.
#
# Inputs (place these in scripts/ceremony/build/ before running):
#   - withdraw.r1cs
#   - powersOfTau28_hez_final_14.ptau     (Hermez Phase-1, public)
#   - withdraw_0000.zkey                   (initiator's output, public)
#   - withdraw_NNNN.zkey × N               (each contribution, public)
#   - withdraw_final.zkey                  (post-beacon, published)
#
# What this script proves:
#   1. The R1CS matches the committed circuit (deterministic build).
#   2. Each .zkey in the chain is a valid contribution to its predecessor.
#   3. The final .zkey verifies against the R1CS + Phase-1 SRS.
#   4. The exported verification_key.json matches the on-chain Rust
#      constants in programs/octora-mixer/src/verifier/groth16.rs.
#
# What this script CANNOT prove:
#   - That at least one contributor was honest. That is what the public
#     attestations + the beacon are for. Verify those out-of-band.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
BUILD="$ROOT/scripts/ceremony/build"
CIRCUIT_DIR="$ROOT/octora-api/src/modules/vault/circuits"

cd "$BUILD"

echo "==> 1/4: Verifying Phase-1 SRS checksum"
PTAU=powersOfTau28_hez_final_14.ptau
PTAU_SHA256="60793d4e8be5cd8c5ec53cebebcdfa7e96b6c3aff35710e8b00e2a39b7327a23"
echo "$PTAU_SHA256  $PTAU" | shasum -a 256 -c -

echo "==> 2/4: Re-compiling circuit and comparing R1CS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

circom "$CIRCUIT_DIR/withdraw.circom" \
  -o "$TMP" \
  --r1cs \
  -l "$ROOT" \
  >/dev/null

# Compare byte-for-byte. Any difference = different circuit.
if ! cmp -s "$TMP/withdraw.r1cs" withdraw.r1cs; then
  echo "FAIL: rebuilt withdraw.r1cs differs from ceremony R1CS." >&2
  echo "  This means the circuit source has been changed since the ceremony." >&2
  exit 1
fi
echo "    circuit reproduces deterministically ✓"

echo "==> 3/4: Verifying every link in the contribution chain"
# Iterate over each withdraw_NNNN.zkey in order, then withdraw_final.zkey.
# Any malformed contribution makes snarkjs zkey verify exit non-zero.
for zkey in $(ls withdraw_*.zkey | sort); do
  echo "  - $zkey"
  "$SNARKJS" zkey verify withdraw.r1cs "$PTAU" "$zkey" >/dev/null
done

echo "==> 4/4: Comparing exported VK to Rust constants on-chain"
"$SNARKJS" zkey export verificationkey withdraw_final.zkey vk-rebuilt.json >/dev/null

if ! cmp -s vk-rebuilt.json "$CIRCUIT_DIR/verification_key.json"; then
  echo "FAIL: rebuilt verification_key.json differs from circuits/verification_key.json." >&2
  exit 1
fi
echo "    on-disk VK matches the final zkey ✓"

# Convert and diff against committed Rust constants.
node "$ROOT/scripts/convert-vk-to-rust.mjs" "$CIRCUIT_DIR/verification_key.json" > vk-rebuilt.rs
RUST_VK="$ROOT/programs/octora-mixer/src/verifier/groth16.rs"

# Cheap structural comparison: the converter outputs the VK_* blocks; we
# extract them from groth16.rs and from vk-rebuilt.rs and diff. Any
# mismatch means the on-chain VK is not the ceremony's VK.
extract_vk_blocks() {
  awk '
    /^pub const VK_(ALPHA|BETA|GAMMA|DELTA|IC)/,/^];/
  ' "$1"
}

if ! diff <(extract_vk_blocks "$RUST_VK") <(extract_vk_blocks vk-rebuilt.rs) >/dev/null; then
  echo "FAIL: on-chain Rust VK constants do not match ceremony output." >&2
  echo "  Run: node $ROOT/scripts/convert-vk-to-rust.mjs $CIRCUIT_DIR/verification_key.json" >&2
  echo "  and replace the VK_* blocks in $RUST_VK." >&2
  exit 1
fi
echo "    on-chain Rust VK matches ✓"

echo ""
echo "Ceremony verification PASSED."
echo ""
echo "Reminder: this script proves chain validity, not honesty. Verify"
echo "each contributor's published attestation independently."
