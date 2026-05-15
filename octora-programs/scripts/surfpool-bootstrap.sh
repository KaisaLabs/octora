#!/usr/bin/env bash
# Fresh-surfpool bootstrap. Assumes `surfpool start` is running in another
# terminal at http://127.0.0.1:8899 (override with RPC_URL).
#
# Steps:
#   1. Sanity-check the RPC is reachable.
#   2. Deploy octora_executor + octora_mixer (skip with SKIP_DEPLOY=1).
#   3. Run scripts/init-surfpool.ts — airdrops admin, inits executor Config
#      PDA, inits all mixer-pool PDAs for the configured denominations.
#
# Idempotent end-to-end: re-running on an already-bootstrapped surfpool
# upgrades the programs (same upgrade authority) and skips already-init
# accounts.
#
# Usage:
#   ./scripts/surfpool-bootstrap.sh                       # full flow
#   SKIP_DEPLOY=1 ./scripts/surfpool-bootstrap.sh         # skip program deploys
#   SKIP_AIRDROP=1 ./scripts/surfpool-bootstrap.sh        # forwarded to TS
#   RPC_URL=http://127.0.0.1:9000 ./scripts/...           # non-default surfpool port

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8899}"

EXEC_KP="$ROOT/target/deploy/octora_executor-keypair.json"
EXEC_SO="$ROOT/target/deploy/octora_executor.so"
MIXER_KP="$ROOT/target/deploy/octora_mixer-keypair.json"
MIXER_SO="$ROOT/target/deploy/octora_mixer.so"
PAYER="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
info() { printf "  %s\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

step "Checking surfpool at $RPC"
solana cluster-version --url "$RPC" >/dev/null 2>&1 \
  || die "RPC not reachable at $RPC — start surfpool first (\`surfpool start\`)"
info "rpc OK ($(solana cluster-version --url "$RPC"))"
info "payer: $(solana address --keypair "$PAYER")"

if [[ "${SKIP_DEPLOY:-0}" == "1" ]]; then
  step "Skipping program deploys (SKIP_DEPLOY=1)"
else
  # Mixer must be built with `permissionless-init` for localnet so any
  # signer (the payer / surfpool admin) can call `initialize`. The default
  # (mainnet) feature set hard-codes `ADMIN_AUTHORITY` in constants.rs and
  # makes `initialize` fail-closed with AnchorError 6010.
  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    step "Building octora_mixer with --features permissionless-init"
    ( cd "$ROOT" && anchor build -p octora_mixer -- --features permissionless-init )
  else
    info "SKIP_BUILD=1 — assuming target/deploy/*.so already include permissionless-init"
  fi

  for pair in "octora_executor:$EXEC_SO:$EXEC_KP" "octora_mixer:$MIXER_SO:$MIXER_KP"; do
    name="${pair%%:*}"; rest="${pair#*:}"; so="${rest%%:*}"; kp="${rest##*:}"
    [[ -f "$so" ]] || die "$so missing — run \`anchor build\` first"
    [[ -f "$kp" ]] || die "$kp missing"
    program_id="$(solana address --keypair "$kp")"
    step "Deploying $name → $program_id"
    solana program deploy "$so" \
      --program-id "$kp" \
      --keypair "$PAYER" \
      --url "$RPC" \
      --upgrade-authority "$PAYER"
  done
fi

step "Running on-chain init (airdrop + executor Config + mixer pools + relayer funding)"
# Forward env to the TS script. Only forward relayer-keypair vars when they
# are actually set in the shell — exporting them as empty strings would
# defeat the .env loader inside the script (Node's process.loadEnvFile does
# not overwrite already-set vars), so an unset shell var must stay unset
# instead of being downgraded to "".
export RPC_URL="$RPC"
export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$PAYER"
export OCTORA_MIXER_ADMIN_KEYPAIR="${OCTORA_MIXER_ADMIN_KEYPAIR:-$PAYER}"
export RELAYER_FUND_SOL="${RELAYER_FUND_SOL:-5}"
[[ -n "${OCTORA_EXECUTOR_RELAYER_KEYPAIR:-}" ]] && export OCTORA_EXECUTOR_RELAYER_KEYPAIR
[[ -n "${OCTORA_MIXER_RELAYER_HOT_WALLET:-}" ]] && export OCTORA_MIXER_RELAYER_HOT_WALLET
npx tsx "$ROOT/scripts/init-surfpool.ts"

step "Done"
