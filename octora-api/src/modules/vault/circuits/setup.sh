#!/usr/bin/env bash
#
# Trusted setup for the Octora vault mixer withdraw circuit.
# Compiles the circom circuit, runs a powers-of-tau ceremony,
# and generates the proving/verification keys.
#
# Prerequisites:
#   - circom 2.1.x installed globally (https://docs.circom.io/getting-started/installation/)
#   - snarkjs installed (already in package.json)
#   - circomlib installed (npm install circomlib)
#
# Usage:
#   cd octora-api
#   npm install circomlib   # one-time, needed for circuit compilation
#   bash src/modules/vault/circuits/setup.sh
#
# Output artifacts (committed to repo):
#   - withdraw.wasm          (witness generator)
#   - withdraw.zkey          (proving key)
#   - verification_key.json  (verification key)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
CIRCUIT="$SCRIPT_DIR/withdraw.circom"

SNARKJS="$(cd "$SCRIPT_DIR/../../.." && pwd)/node_modules/.bin/snarkjs"

echo "==> Setting up build directory"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Step 1: Compile the circuit ──
echo "==> Compiling circuit..."
circom "$CIRCUIT" \
  --r1cs "$BUILD_DIR/withdraw.r1cs" \
  --wasm "$BUILD_DIR" \
  --sym "$BUILD_DIR/withdraw.sym" \
  -l "$(cd "$SCRIPT_DIR/../../.." && pwd)/node_modules"

echo "    R1CS, WASM, and SYM files generated."

# ── Step 2: Powers of Tau ceremony (BN128, power 16) ──
echo "==> Starting powers-of-tau ceremony..."
"$SNARKJS" powersoftau new bn128 16 "$BUILD_DIR/pot16_0.ptau" -v

echo "==> Contributing to ceremony..."
"$SNARKJS" powersoftau contribute \
  "$BUILD_DIR/pot16_0.ptau" \
  "$BUILD_DIR/pot16_1.ptau" \
  --name="octora-devnet-ceremony" \
  --entropy="octora-devnet-mvp-$(date +%s)"

echo "==> Preparing phase 2..."
"$SNARKJS" powersoftau prepare phase2 \
  "$BUILD_DIR/pot16_1.ptau" \
  "$BUILD_DIR/pot16_final.ptau" \
  -v

# ── Step 3: Generate proving key (.zkey) ──
echo "==> Generating proving key (phase 2 setup)..."
"$SNARKJS" groth16 setup \
  "$BUILD_DIR/withdraw.r1cs" \
  "$BUILD_DIR/pot16_final.ptau" \
  "$BUILD_DIR/withdraw_0.zkey"

echo "==> Contributing to phase 2..."
"$SNARKJS" zkey contribute \
  "$BUILD_DIR/withdraw_0.zkey" \
  "$BUILD_DIR/withdraw.zkey" \
  --name="octora-devnet-phase2" \
  --entropy="octora-phase2-$(date +%s)"

# ── Step 4: Export verification key ──
echo "==> Exporting verification key..."
"$SNARKJS" zkey export verificationkey \
  "$BUILD_DIR/withdraw.zkey" \
  "$BUILD_DIR/verification_key.json"

# ── Step 5: Copy final artifacts to circuits dir ──
echo "==> Copying artifacts..."
cp "$BUILD_DIR/withdraw_js/withdraw.wasm" "$SCRIPT_DIR/withdraw.wasm"
cp "$BUILD_DIR/withdraw.zkey" "$SCRIPT_DIR/withdraw.zkey"
cp "$BUILD_DIR/verification_key.json" "$SCRIPT_DIR/verification_key.json"

# ── Cleanup intermediate files ──
echo "==> Cleaning up intermediate files..."
rm -rf "$BUILD_DIR"

echo ""
echo "Done! Artifacts ready in $SCRIPT_DIR/:"
echo "  - withdraw.wasm          (witness generator)"
echo "  - withdraw.zkey          (proving key)"
echo "  - verification_key.json  (verification key)"
