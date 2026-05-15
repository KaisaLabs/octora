#!/usr/bin/env bash
#
# Phase-2 ceremony — STEP 2: finalize.
#
# Run by the coordinator AFTER all contributors have submitted their
# zkeys and published their attestations. Applies a public-randomness
# beacon and exports the final verification key.
#
# The beacon binds the final zkey to a public future event (a Bitcoin
# block hash) — this proves the coordinator could not have known the
# beacon at the time the last contributor handed off, so the coordinator
# cannot retroactively re-run contributions to bias the result.
#
# Usage:
#   bash 02-finalize.sh <last-contributor-zkey> <btc-block-hash>
#
# Example:
#   bash 02-finalize.sh withdraw_0003.zkey 000000000000000000017d4d2c8e...
#
# Pick a Bitcoin block hash from a height AFTER the last contribution
# (within ~24h). The user community must be able to verify the block
# was not predictable when contributors signed off.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <last-contributor-zkey> <btc-block-hash>" >&2
  exit 1
fi

LAST="$1"
BEACON="$2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
BUILD="$ROOT/scripts/ceremony/build"
CIRCUIT_DIR="$ROOT/octora-api/src/modules/vault/circuits"

# Validate beacon looks like a SHA256 hex digest.
if ! [[ "$BEACON" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Beacon must be a 64-char lowercase hex string (e.g. a Bitcoin block hash)." >&2
  exit 1
fi

cd "$BUILD"

echo "==> Verifying full contribution chain before beacon"
"$SNARKJS" zkey verify \
  withdraw.r1cs \
  powersOfTau28_hez_final_14.ptau \
  "$LAST"

echo "==> Applying beacon"
# `10` = number of iterations of the "random beacon" mixing function.
# 10 is snarkjs's own recommended value (see snarkjs docs). Higher
# iterations slow down the beacon application proportionally.
"$SNARKJS" zkey beacon \
  "$LAST" \
  withdraw_final.zkey \
  "$BEACON" \
  10 \
  -n="Final Beacon — BTC block $BEACON"

echo "==> Verifying final zkey"
"$SNARKJS" zkey verify \
  withdraw.r1cs \
  powersOfTau28_hez_final_14.ptau \
  withdraw_final.zkey

echo "==> Exporting verification key"
"$SNARKJS" zkey export verificationkey \
  withdraw_final.zkey \
  verification_key.json

echo ""
echo "==> Final artifact checksums:"
shasum -a 256 withdraw_final.zkey verification_key.json | tee final.sha256

# Copy the production artifacts into the canonical location used by the
# circuit module + the on-chain verifier conversion script.
cp verification_key.json "$CIRCUIT_DIR/verification_key.json"
cp withdraw_final.zkey "$CIRCUIT_DIR/withdraw.zkey"
echo "==> Installed to $CIRCUIT_DIR/"

echo ""
echo "Next: convert verification_key.json into Rust constants:"
echo "  node $ROOT/scripts/convert-vk-to-rust.mjs $CIRCUIT_DIR/verification_key.json"
echo "  → paste output into programs/octora-mixer/src/verifier/groth16.rs"
echo ""
echo "Then: cargo build-sbf, redeploy, and publish CEREMONY.md transcript."
