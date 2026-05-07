#!/usr/bin/env bash
#
# Phase-2 ceremony — STEP 0: initiator-only.
#
# Run by the ceremony coordinator on a clean machine ONCE. Produces:
#   - withdraw.r1cs              (compiled circuit, deterministic)
#   - powersOfTau28_hez_final_14.ptau  (Hermez Phase-1 universal SRS)
#   - withdraw_0000.zkey         (initial Phase-2 zkey, no contributions)
#
# The output is deterministic and contains no toxic waste — anyone can
# verify it by re-running this script and comparing checksums.
#
# Hand `withdraw_0000.zkey` (and the .ptau if not already public) to the
# first contributor (see 01-contribute.sh).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIRCUIT_DIR="$ROOT/octora-api/src/modules/vault/circuits"
OUT_DIR="$ROOT/scripts/ceremony/build"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# ── Phase-1 SRS ──────────────────────────────────────────────────────────
# Hermez's pot14 covers up to 2^14 constraints. The withdraw circuit is
# ~5400 constraints, so pot14 is plenty. If the circuit ever grows past
# ~16k constraints, bump to pot15 and re-run from here.
PTAU=powersOfTau28_hez_final_14.ptau
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/$PTAU"
# SHA256 published by iden3/Hermez. Verify any time you re-download.
PTAU_SHA256="60793d4e8be5cd8c5ec53cebebcdfa7e96b6c3aff35710e8b00e2a39b7327a23"

if [ ! -f "$PTAU" ]; then
  echo "==> Downloading $PTAU"
  curl -L -o "$PTAU" "$PTAU_URL"
fi

echo "==> Verifying Phase-1 SRS checksum"
echo "$PTAU_SHA256  $PTAU" | shasum -a 256 -c -

# ── Compile circuit ──────────────────────────────────────────────────────
# The circuit is committed to git, but we re-compile here so the ceremony
# is reproducible from source. The R1CS is deterministic given the same
# circom version + circomlib commit.
echo "==> Compiling withdraw.circom"
command -v circom >/dev/null || {
  echo "circom not found. Install from https://docs.circom.io/getting-started/installation/" >&2
  exit 1
}

circom "$CIRCUIT_DIR/withdraw.circom" \
  -o "$OUT_DIR" \
  --r1cs --wasm --sym \
  -l "$ROOT"

# Pin the circom version into the transcript so contributors can verify.
circom --version | tee circom-version.txt

# ── Phase-2 initial zkey ─────────────────────────────────────────────────
SNARKJS="$ROOT/node_modules/.bin/snarkjs"

echo "==> Generating initial Phase-2 zkey"
"$SNARKJS" groth16 setup \
  withdraw.r1cs \
  "$PTAU" \
  withdraw_0000.zkey

echo "==> Initial zkey checksum (publish this in the transcript):"
shasum -a 256 withdraw_0000.zkey | tee withdraw_0000.zkey.sha256

echo ""
echo "Done. Hand off to first contributor:"
echo "  $OUT_DIR/withdraw_0000.zkey"
echo "  $OUT_DIR/$PTAU"
echo ""
echo "Next: each contributor runs 01-contribute.sh (see CEREMONY.md)."
