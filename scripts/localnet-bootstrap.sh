#!/usr/bin/env bash
# Bootstrap an octora ↔ Meteora DLMM environment.
#
# Default target is **devnet** (no local validator headaches: DLMM, Memo v2,
# Token-2022, Metaplex, etc. are all already deployed by Meteora/Solana).
# Set NETWORK=localnet to use a local `start-test-validator` instead.
#
# Steps:
#   1. Sanity-check the RPC (and on localnet, the loaded Meteora programs)
#   2. Top up the studio keypair (devnet airdrop / localnet airdrop)
#   3. Deploy octora_executor + octora_mixer
#   4. Create DLMM pool (skipped if a base mint is already cached)
#   5. Seed single-bin liquidity against that pool
#
# Usage:
#   ./scripts/localnet-bootstrap.sh                       # devnet, full flow
#   NETWORK=localnet ./scripts/localnet-bootstrap.sh      # localnet instead
#   ./scripts/localnet-bootstrap.sh <BASE_MINT>           # reuse an existing mint
#   FORCE_CREATE_POOL=1 ./scripts/localnet-bootstrap.sh   # ignore mint cache
#   SKIP_DEPLOY=1       ./scripts/localnet-bootstrap.sh   # skip program deploys
#   SKIP_SEED=1         ./scripts/localnet-bootstrap.sh   # stop after pool create
#   STRICT_DEPLOY=1     ./scripts/localnet-bootstrap.sh   # fail (don't skip) on authority mismatch

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUDIO="$ROOT/meteora-invent/studio"
DLMM_CFG="$STUDIO/config/dlmm_config.jsonc"
KEYPAIR="$STUDIO/keypair.json"
PAYER_PUBKEY="$(solana address --keypair "$KEYPAIR")"

NETWORK="${NETWORK:-devnet}"
case "$NETWORK" in
  devnet)
    RPC="https://api.devnet.solana.com"
    AIRDROP_FLAG="--url $RPC"
    TARGET_SOL=10            # devnet faucet caps individual airdrops at 1–2 SOL
    AIRDROP_PER_TRY=2
    MAX_AIRDROP_ATTEMPTS=8
    STATE_FILE="$ROOT/scripts/.devnet-state.env"
    ;;
  localnet)
    RPC="http://localhost:8899"
    AIRDROP_FLAG="--url $RPC"
    TARGET_SOL=50            # localnet has no rate limits
    AIRDROP_PER_TRY=10
    MAX_AIRDROP_ATTEMPTS=10
    STATE_FILE="$ROOT/scripts/.localnet-state.env"
    ;;
  *)
    echo "NETWORK must be 'devnet' or 'localnet' (got: $NETWORK)" >&2
    exit 1
    ;;
esac

EXEC_KP="$ROOT/target/deploy/octora_executor-keypair.json"
EXEC_SO="$ROOT/target/deploy/octora_executor.so"
MIXER_KP="$ROOT/target/deploy/octora_mixer-keypair.json"
MIXER_SO="$ROOT/target/deploy/octora_mixer.so"

# Programs that must be loaded on the validator for the seed flow to work.
# Only enforced on localnet (Meteora pre-deploys all of these on devnet/mainnet).
LOCALNET_REQUIRED_PROGRAMS=(
  "LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ:DLMM (lb_clmm)"
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s:Metaplex Token Metadata"
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr:SPL Memo v2"
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb:Token-2022"
  "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn:Locker"
)

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
info() { printf "  %s\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*" >&2; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

CLI_BASE_MINT="${1:-}"

# 0. Make sure dlmm_config.jsonc points at the right RPC. The studio reads this
#    file at runtime — there's no CLI override — so we patch it in place.
sync_dlmm_rpc() {
  [[ -f "$DLMM_CFG" ]] || die "DLMM config missing: $DLMM_CFG"
  local current
  current=$(grep -oE '"rpcUrl"\s*:\s*"[^"]*"' "$DLMM_CFG" | head -1 | sed -E 's/.*"rpcUrl"\s*:\s*"([^"]*)".*/\1/')
  if [[ "$current" != "$RPC" ]]; then
    info "patching dlmm_config.jsonc rpcUrl: $current → $RPC"
    # macOS sed needs the empty-string -i argument.
    sed -i '' -E "s|(\"rpcUrl\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"$RPC\"|" "$DLMM_CFG"
  else
    info "dlmm_config.jsonc rpcUrl already $RPC"
  fi
}

# 1. RPC reachable + (localnet only) required programs loaded
step "Checking $NETWORK at $RPC"
solana cluster-version --url "$RPC" >/dev/null 2>&1 \
  || die "RPC not reachable at $RPC"
info "rpc OK ($(solana cluster-version --url "$RPC"))"
info "payer: $PAYER_PUBKEY"
sync_dlmm_rpc

if [[ "$NETWORK" == "localnet" ]]; then
  MISSING=()
  for entry in "${LOCALNET_REQUIRED_PROGRAMS[@]}"; do
    pid="${entry%%:*}"; name="${entry#*:}"
    if solana program show "$pid" --url "$RPC" >/dev/null 2>&1; then
      info "ok  $name ($pid)"
    else
      MISSING+=("$name ($pid)")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    warn "Missing programs on validator:"
    for m in "${MISSING[@]}"; do printf "    - %s\n" "$m" >&2; done
    die "Restart with: pnpm --filter @meteora-invent/studio start-test-validator"
  fi
fi

# 2. Top up payer.
step "Funding payer (target: $TARGET_SOL SOL)"
attempts=0
while :; do
  BAL=$(solana balance --keypair "$KEYPAIR" --url "$RPC" | awk '{print $1}')
  BAL_INT=${BAL%.*}
  if (( BAL_INT >= TARGET_SOL )); then
    info "balance: $BAL SOL (≥ $TARGET_SOL — done)"
    break
  fi
  if (( attempts >= MAX_AIRDROP_ATTEMPTS )); then
    if [[ "$NETWORK" == "devnet" ]]; then
      warn "Could not airdrop enough SOL (have $BAL, need $TARGET_SOL)."
      warn "Devnet faucet is rate-limited — top up manually at https://faucet.solana.com/?cluster=devnet"
      warn "  payer: $PAYER_PUBKEY"
      warn "Re-run when the balance is sufficient."
      exit 1
    else
      die "Airdrop kept failing on localnet — investigate the validator"
    fi
  fi
  attempts=$((attempts + 1))
  info "balance: $BAL SOL — airdropping $AIRDROP_PER_TRY SOL (attempt $attempts/$MAX_AIRDROP_ATTEMPTS)"
  if ! solana airdrop "$AIRDROP_PER_TRY" "$PAYER_PUBKEY" $AIRDROP_FLAG >/dev/null 2>&1; then
    warn "airdrop call failed (rate-limited?), retrying in 5s"
    sleep 5
  fi
done

# 3. Deploy octora programs (skippable)
#
# Devnet programs persist across runs. If a program already exists with a
# different upgrade authority than ours, we can't upgrade it — but it's
# already on chain and usable for tests, so we skip with a warning.
# Set STRICT_DEPLOY=1 to fail instead.
deploy_program() {
  local name="$1" so="$2" kp="$3"
  [[ -f "$so" ]] || die "$so missing — run \`anchor build\` first"
  [[ -f "$kp" ]] || die "$kp missing"
  local program_id
  program_id=$(solana address --keypair "$kp")

  local show_out
  if show_out=$(solana program show "$program_id" --url "$RPC" 2>/dev/null) && [[ -n "$show_out" ]]; then
    local on_chain_authority
    on_chain_authority=$(printf '%s\n' "$show_out" | awk -F': *' '$1=="Authority"{print $2; exit}')
    if [[ -n "$on_chain_authority" && "$on_chain_authority" != "$PAYER_PUBKEY" ]]; then
      step "$name already deployed at $program_id"
      warn "On-chain upgrade authority is $on_chain_authority (we're $PAYER_PUBKEY) — can't upgrade."
      if [[ "${STRICT_DEPLOY:-0}" == "1" ]]; then
        die "Set STRICT_DEPLOY=0 (default) to skip, or transfer authority with: solana program set-upgrade-authority $program_id --new-upgrade-authority $PAYER_PUBKEY --url $RPC"
      fi
      info "Skipping deploy — using the existing on-chain program."
      info "If you need to push fresh code, ask the holder of $on_chain_authority to transfer authority, or rotate the program keypair."
      return 0
    fi
    step "Upgrading $name → $program_id"
  else
    step "Deploying $name (fresh) → $program_id"
  fi

  solana program deploy "$so" \
    --program-id "$kp" \
    --keypair "$KEYPAIR" \
    --url "$RPC" \
    --upgrade-authority "$KEYPAIR"
}
if [[ "${SKIP_DEPLOY:-0}" == "1" ]]; then
  step "Skipping octora program deploys (SKIP_DEPLOY=1)"
else
  deploy_program "octora_executor" "$EXEC_SO" "$EXEC_KP"
  deploy_program "octora_mixer"    "$MIXER_SO" "$MIXER_KP"
fi

# 4. Decide whether to create a pool or reuse a cached base mint.
BASE_MINT=""
CACHED_MINT=""
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE" || true
  CACHED_MINT="${BASE_MINT:-}"
fi

if [[ -n "$CLI_BASE_MINT" ]]; then
  BASE_MINT="$CLI_BASE_MINT"
  step "Using base mint from CLI arg: $BASE_MINT (skipping create-pool)"
elif [[ -n "$CACHED_MINT" && "${FORCE_CREATE_POOL:-0}" != "1" ]]; then
  BASE_MINT="$CACHED_MINT"
  step "Using cached base mint from $STATE_FILE: $BASE_MINT (skipping create-pool)"
  info "Set FORCE_CREATE_POOL=1 to mint a fresh token instead."
else
  step "Creating DLMM pool"
  cd "$STUDIO"
  LOG=$(mktemp)
  trap 'rm -f "$LOG"' EXIT
  set +e
  pnpm dlmm-create-pool 2>&1 | tee "$LOG"
  PIPE_STATUS=${PIPESTATUS[0]}
  set -e
  (( PIPE_STATUS == 0 )) || die "dlmm-create-pool failed (exit $PIPE_STATUS)"

  BASE_MINT=$(grep -oE 'Using base token mint [1-9A-HJ-NP-Za-km-z]{32,44}' "$LOG" | tail -1 | awk '{print $NF}')
  [[ -n "${BASE_MINT:-}" ]] || die "Could not parse base mint from output"
  printf 'BASE_MINT=%s\n' "$BASE_MINT" > "$STATE_FILE"
  info "base mint: $BASE_MINT (cached → $STATE_FILE)"
fi

# 5. Seed liquidity (single bin) — skippable
if [[ "${SKIP_SEED:-0}" == "1" ]]; then
  step "Skipping seed (SKIP_SEED=1)"
else
  step "Seeding single-bin liquidity"
  cd "$STUDIO"
  pnpm dlmm-seed-liquidity-single-bin --baseMint "$BASE_MINT"
fi

step "Done"
explorer_suffix=""
[[ "$NETWORK" == "devnet" ]] && explorer_suffix="?cluster=devnet"
cat <<EOF
  network     : $NETWORK
  payer       : $PAYER_PUBKEY
  base mint   : $BASE_MINT
  quote mint  : So11111111111111111111111111111111111111112 (SOL)
  rpc         : $RPC
  state file  : $STATE_FILE

Inspect:
  https://explorer.solana.com/address/$BASE_MINT$explorer_suffix
  https://explorer.solana.com/address/$PAYER_PUBKEY$explorer_suffix

Re-run hints:
  - Re-seed against the same pool:           ./scripts/localnet-bootstrap.sh
  - Force a fresh token + pool:              FORCE_CREATE_POOL=1 ./scripts/localnet-bootstrap.sh
  - Skip program deploys (faster iteration): SKIP_DEPLOY=1 ./scripts/localnet-bootstrap.sh
  - Stop after pool creation:                SKIP_SEED=1 ./scripts/localnet-bootstrap.sh
  - Switch back to localnet:                 NETWORK=localnet ./scripts/localnet-bootstrap.sh
  - LFG (curve) seed instead of single-bin:  cd $STUDIO && pnpm dlmm-seed-liquidity-lfg --baseMint $BASE_MINT
EOF
