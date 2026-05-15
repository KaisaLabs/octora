#!/usr/bin/env bash
#
# Phase-2 ceremony — STEP 1: contributor.
#
# EACH contributor runs this on a clean / freshly-booted machine. Takes
# the previous contributor's output zkey (or the initiator's
# withdraw_0000.zkey) and produces a new contribution.
#
# Usage:
#   bash 01-contribute.sh <input.zkey> <output.zkey> "Your Name <email/handle>"
#
# Example (you are contributor #2):
#   bash 01-contribute.sh withdraw_0001.zkey withdraw_0002.zkey "Alice <alice@example.com>"
#
# What you MUST do:
#   1. Run on a machine you trust. A freshly-booted Linux laptop is best.
#      Disconnect from the network during contribution. Reconnect only to
#      send the output zkey to the next contributor.
#   2. After running, destroy the entropy. The script feeds /dev/urandom
#      into snarkjs, but YOU should also reboot or wipe the working
#      directory to make best-effort destruction.
#   3. Publish your `attestation.txt` (printed below) on a public channel
#      Twitter, GitHub gist, Discord — to bind your contribution to your
#      identity. The transcript is what makes the ceremony auditable.
#
# What you MUST NOT do:
#   - Run on a shared/multi-user machine.
#   - Reuse the same machine across contributions if it could have been
#     compromised between runs.
#   - Skip publishing your attestation — without it, the ceremony has
#     N-1 contributors from a security standpoint.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <input.zkey> <output.zkey> \"Your Name\"" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="$2"
NAME="$3"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"

if [ ! -f "$INPUT" ]; then
  echo "Input zkey not found: $INPUT" >&2
  exit 1
fi

# Verify the input chain is intact before adding to it. If any prior
# contribution was malformed, the verifier rejects the entire chain.
echo "==> Verifying input chain so far"
"$SNARKJS" zkey verify \
  "$ROOT/scripts/ceremony/build/withdraw.r1cs" \
  "$ROOT/scripts/ceremony/build/powersOfTau28_hez_final_14.ptau" \
  "$INPUT"

# Pull 1024 bytes of entropy from the kernel CSPRNG. snarkjs hashes this
# with its own internal entropy gathering. NEVER hardcode entropy strings;
# the script in setup.sh used `date +%s` which is publicly guessable and
# is the reason that script is dev-only.
ENTROPY="$(head -c 1024 /dev/urandom | base64 | tr -d '\n')"

echo "==> Contributing as: $NAME"
"$SNARKJS" zkey contribute \
  "$INPUT" \
  "$OUTPUT" \
  --name="$NAME" \
  -v \
  -e="$ENTROPY"

# Forget the entropy. (snarkjs has already used it; we're paranoid.)
unset ENTROPY

echo ""
echo "==> Contribution checksum (include in attestation):"
SHA="$(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
echo "$SHA  $OUTPUT"

# Generate an attestation file the contributor publishes.
ATTEST="${OUTPUT%.zkey}.attestation.txt"
cat > "$ATTEST" <<EOF
Octora Mixer — Phase-2 ceremony attestation
===========================================

Contributor: $NAME
Date (UTC):  $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Input zkey:  $(basename "$INPUT") ($(shasum -a 256 "$INPUT" | awk '{print $1}'))
Output zkey: $(basename "$OUTPUT") ($SHA)

I attest that:
  1. I ran 01-contribute.sh on a machine I controlled and trusted.
  2. I sourced entropy from /dev/urandom on that machine.
  3. I did not retain or transmit any toxic waste; the working directory
     has been destroyed (or will be, immediately after this attestation
     is published).
  4. I have not been coerced.

Signature (manual): __________________________________
EOF

echo ""
echo "Done. Next steps:"
echo "  1. Send $OUTPUT to the next contributor (or to the coordinator if you are last)."
echo "  2. Publish $ATTEST on a public channel under your verified identity."
echo "  3. Wipe $(dirname "$OUTPUT")/*.zkey from this machine after handoff."
