# Localnet — full claim + withdraw simulation

End-to-end runbook for bringing up a fresh localnet that mirrors mainnet behaviour for the **deposit → add-liquidity → claim → withdraw-close** flow. Run it once to verify your local stack actually executes on-chain CPIs before you ever touch devnet/mainnet.

> **Why localnet?** It's the only tier where the on-chain `dlmm_claim_fees` and `dlmm_withdraw_close` CPIs run against a real Meteora DLMM program in seconds, with no airdrop limits and no shared state to corrupt.

---

## 0. Prerequisites

Install once:

- **Solana CLI** ≥ 1.18 (`solana --version`)
- **Anchor CLI** ≥ 0.30 (`anchor --version`) — only needed if you intend to rebuild the programs
- **Node 20+** and **pnpm 10** (`pnpm --version`)
- **PostgreSQL 16** (the API uses it). Docker Compose is fine.

Pre-built artifacts you need on disk (already in this repo):
- `target/deploy/octora_mixer.so` and `octora_mixer-keypair.json`
- `target/deploy/octora_executor.so` and `octora_executor-keypair.json`
- `tests/fixtures/meteora_dlmm.so` (cloned from mainnet)

If `target/deploy/*.so` is missing, run `anchor build` from the repo root once.

---

## 1. Start the local validator with all required programs loaded

The repo ships `npm run validator` already wired to load **all three** programs and clone the two on-chain accounts that DLMM expects (`event_authority` and a preset_parameter PDA):

```bash
# Terminal 1 — leave running
npm run validator
```

What this does (`package.json:13`):

| Loaded into genesis | Purpose |
|---|---|
| `BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx` ← `octora_mixer.so` | Mixer pool program |
| `4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK` ← `octora_executor.so` | Executor (LP wrapper) program |
| `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` ← `meteora_dlmm.so` | Meteora DLMM (cloned binary) |
| `--clone D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6` | DLMM event_authority account |
| `--clone BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63` | DLMM preset_parameter (binStep=10, baseFactor=10000) |

The validator runs at `http://127.0.0.1:8899`. Confirm:

```bash
solana cluster-version --url http://127.0.0.1:8899
solana program show BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx --url http://127.0.0.1:8899
```

---

## 2. Fund the local wallets

You need three SOL-funded wallets:

1. **Admin** — initialises the mixer pool once. Reuse `~/.config/solana/id.json`.
2. **Mixer relayer** — pays gas for `mixer.withdraw`. Same path is fine for local; production keeps them separate.
3. **Executor relayer** — pays gas for `dlmm_init_position` / `add_liquidity` / `claim_fees` / `withdraw_close`. Same path is fine for local.

Airdrop:

```bash
solana airdrop 100 -u http://127.0.0.1:8899 $(solana address)
```

Verify:

```bash
solana balance -u http://127.0.0.1:8899
# expect: 100 SOL
```

---

## 3. Initialise the mixer pool (one-time)

The mixer is a singleton per denomination. Default denomination is **1 SOL = 1_000_000_000 lamports**.

```bash
# Terminal 2
OCTORA_MIXER_PROGRAM_ID=BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx \
OCTORA_MIXER_ADMIN_KEYPAIR=$HOME/.config/solana/id.json \
OCTORA_EXECUTOR_RPC_URL=http://127.0.0.1:8899 \
MIXER_DENOMINATION=1000000000 \
npx tsx scripts/init-mixer-pool.ts
```

Expected output ends with `Initialized. Tx: <sig>`. The pool PDA is now live for this session — re-running the script will refuse to re-init.

---

## 4. Bring up Postgres + the API

The API needs Postgres for the position state machine. Easiest path:

```bash
# Terminal 3 — Postgres (any 16-compatible image works)
docker run -d --name octora-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=octora \
  -p 5432:5432 postgres:16

# Apply schema
cd octora-api
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/octora pnpm exec prisma migrate deploy
```

Now create `octora-api/.env`:

```ini
PORT=8787
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/octora
FRONTEND_URL=http://127.0.0.1:3100

# Both program IDs match Anchor.toml [programs.localnet]
OCTORA_MIXER_PROGRAM_ID=BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx
OCTORA_EXECUTOR_PROGRAM_ID=4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK

# Localnet RPC for both the mixer service and the executor service
SOLANA_RPC_URL=http://127.0.0.1:8899
OCTORA_EXECUTOR_RPC_URL=http://127.0.0.1:8899

# Hot wallets (keep both in dev, separate them in prod)
OCTORA_MIXER_RELAYER_KEYPAIR=/Users/<you>/.config/solana/id.json
OCTORA_EXECUTOR_RELAYER_KEYPAIR=/Users/<you>/.config/solana/id.json

# Pool config
MIXER_DENOMINATION=1000000000
OCTORA_MIXER_RELAYER_FEE=2000000

# Keep the executor mock OFF for the lifecycle endpoints — we want real CPI.
# (The pool-detail page does not go through this flag; it calls /executor/*-tx
# which is always real on-chain. This flag only matters for /positions/:id/*.)
OCTORA_USE_ONCHAIN_EXECUTOR=true

# Resend isn't used on localnet; placeholder keeps the SDK happy.
RESEND_API_KEY=re_localnet_placeholder
```

Start the API:

```bash
pnpm dev
# expect: "[api] listening on 8787"
# the mixer cache hydrates from chain on boot — should report 0 deposits initially
```

Quick smoke test:

```bash
curl http://127.0.0.1:8787/health           # {"ok":true}
curl http://127.0.0.1:8787/mixer/status     # 200 with poolAddress + nextLeafIndex=0
curl http://127.0.0.1:8787/relayer/info     # advertises relayer pubkey + fee
```

If `/mixer/status` returns 404, step 3 was skipped or used a different denomination.

---

## 5. Bring up the frontend

```bash
# Terminal 4
cd octora-web
```

Create `octora-web/.env.local`:

```ini
VITE_API_URL=http://127.0.0.1:8787
VITE_RPC_URL=http://127.0.0.1:8899
VITE_NETWORK=localnet
```

Start it:

```bash
pnpm dev    # vite — http://127.0.0.1:3000
```

Important: Phantom defaults to mainnet. Switch your wallet to a custom RPC pointing at `http://127.0.0.1:8899` before connecting. In Phantom: **Settings → Developer Settings → Change Network → Add Custom RPC → URL `http://127.0.0.1:8899`**.

---

## 6. Create a DLMM pool and a private position

Localnet starts with **no DLMM pools**. The `IntegratedTestPage` exists for exactly this — it sets up a test pair and walks the full deposit:

1. Open `http://127.0.0.1:3000/integrated-test`.
2. Connect wallet (the one with the 100 SOL).
3. **Setup test pair** → API mints two SPL tokens, creates a fresh DLMM pool, and seeds the bin arrays. Note the `lbPair` address it prints.
4. **Init position → Mixer deposit → Mixer withdraw → Add liquidity** in order. Each step prints a tx signature; you should see all of them confirm in `solana logs --url http://127.0.0.1:8899` if you have a fifth terminal open.

By the end you have:
- A real DLMM pool with a real `lb_pair` address.
- A real `PoolAuthority` PDA owned by your stealth wallet.
- A real `Position` account with non-zero liquidity, sitting on the SOL side of the active bin.

Copy the `lbPair` address — it's the input for the next step.

---

## 7. Drive a real claim from the pool detail page

This is the integration the previous session shipped. Open:

```
http://127.0.0.1:3000/pool/<lbPair-address-from-step-6>
```

(or use the **Pools** tab to find it; localnet pools won't appear in the indexer-driven list yet, so direct-linking is the reliable path.)

On the **Claim** tab, hit **Claim fees**. Watch what happens, end-to-end:

1. Wallet pops a `signMessage` request — that's `deriveStealthForPool` recovering the same stealth keypair you used for deposit. **No on-chain tx for this step.** The message includes only the pool address and a stable version tag.
2. Frontend calls `GET /executor/pool-authority?stealth=…&lbPair=…`. The API decodes the on-chain `PoolAuthority` PDA, reads the `position` pubkey, and uses the DLMM SDK to read `position.lowerBinId` / `upperBinId`. That payload is what feeds `/executor/use-pool` so the right `bin_array_lower` / `bin_array_upper` PDAs are derived.
3. Frontend calls `POST /executor/claim-fees-tx`. The API builds the `dlmm_claim_fees` instruction with the 14-account remaining-accounts list (account ordering checked against `programs/octora-executor/src/instructions/dlmm/claim_fees.rs`), idempotently creates the `exit_recipient` ATAs for tokenX and tokenY, pre-signs the tx as fee-payer, and returns base64.
4. Browser deserialises, `partialSign`s with the stealth keypair (no popup — we already have the keypair from step 1), and broadcasts to the localnet RPC.
5. Toast: `Claimed. Funds → <exit-recipient>` plus the tx signature.

Verify on-chain:

```bash
solana confirm <tx-sig> --url http://127.0.0.1:8899
solana logs --url http://127.0.0.1:8899 4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK
# expect: "Program log: Instruction: DlmmClaimFees" + DLMM CPI
```

Token balances:

```bash
# replace <exit-recipient> with the address from the toast
spl-token accounts --url http://127.0.0.1:8899 --owner <exit-recipient>
```

Both tokenX and tokenY ATAs should exist. In the freshly-deposited single-sided SOL case the fee balance is 0 because no swaps have happened against the pool yet — that's *expected*. To prove the path actually carries funds:

```bash
# Trigger a swap against the DLMM pool from another wallet to accrue fees.
# The IntegratedTestPage has no swap UI; the simplest way is the DLMM SDK in a
# scratch script, or just `solana transfer` enough SOL to the pool's reserve
# and send a swap via `dlmm.swap()`. After a real swap, claim again — fee
# balances should be non-zero.
```

---

## 8. Drive a real withdraw-close from the pool detail page

Same page, **Withdraw** tab → **Withdraw privately**.

The flow is identical to claim except the API builds `dlmm_withdraw_close(lower, upper, 10000)` (100% exit) — see `octora-executor/src/instructions/dlmm/withdraw_close.rs`. All position liquidity removes, the position account is closed, rent comes back to the `exit_recipient`. Verify:

```bash
# The position account should be gone after close (100% bps).
solana account <position-pubkey> --url http://127.0.0.1:8899
# expect: "Error: AccountNotFound" — that's what success looks like.
```

The `PoolAuthority` PDA itself stays alive (it's the executor's container, not the DLMM position). The next deposit into the same `(stealth, lbPair)` would re-init a fresh DLMM position underneath it.

Caveat: the current pool-detail UI calls `runWithdrawClose` which exits 100% regardless of slider position. The slider is informational only until partial withdraws are added.

---

## 9. Smoke matrix — what's exercised end-to-end on localnet

| Surface | Localnet exercises | Mainnet-equivalent? |
|---|---|---|
| `mixer.deposit` (Poseidon insert, root advance, `DepositEvent`) | yes | yes |
| `mixer.withdraw` (Groth16 proof verify, nullifier write, fund transfer) | yes | yes |
| Relayer signs + broadcasts mixer withdrawals | yes | yes |
| `executor.dlmm_init_position` (PoolAuthority PDA, exit_recipient binding) | yes | yes |
| `executor.dlmm_add_liquidity` (LiquidityParameterByStrategy, single-sided SOL) | yes | yes |
| `executor.dlmm_claim_fees` (14-account CPI, exit_recipient ATAs) | **yes (this guide)** | yes |
| `executor.dlmm_withdraw_close` (17-account CPI, position close) | **yes (this guide)** | yes |
| Stealth wallet derivation from `signMessage` (deterministic) | yes | yes |
| `/positions/:id/claim` lifecycle endpoint (state machine + activity log) | mocked unless `OCTORA_USE_ONCHAIN_EXECUTOR=true` *and* `position.service` threads `OnchainPositionContext` (TODO) | depends on same flag |

Everything in the **deposit → add-liq → claim → withdraw** golden path is real CPI on localnet. The only mock surface remaining is the *managed lifecycle wrapper* in `position.service.ts` — see `docs/test-plan.md` §13 for the open gap.

---

## 10. Common breakages

| Symptom | Cause |
|---|---|
| `Mixer pool ... not initialized` from `/mixer/deposit` | Skipped step 3, or different `MIXER_DENOMINATION` between init and the API |
| `RootNotFound` on withdraw | Validator was reset between deposit and withdraw — root history doesn't survive `--reset` |
| `AccountNotFound` for `event_authority` during DLMM CPI | Validator started without the `--clone D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6` flag |
| `AccountBorrowFailed` in DLMM during add-liquidity | Position range fits in a single bin array; `useExistingPool` should auto-widen — file a bug if it doesn't |
| Phantom shows 0 SOL despite airdrop | Wallet still on mainnet; switch to the custom RPC at `http://127.0.0.1:8899` |
| `/relayer/withdraw` returns `relayer_unfunded` | Relayer keypair has no SOL on localnet — airdrop to it explicitly |
| Web app shows "Failed to fetch" on every API call | `VITE_API_URL` not set, or API isn't running |

---

## 11. Resetting cleanly

`Ctrl+C` the validator, then:

```bash
npm run validator:reset            # wipes .anchor/test-ledger
docker exec octora-pg psql -U postgres -c 'DROP DATABASE octora; CREATE DATABASE octora;'
cd octora-api && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/octora pnpm exec prisma migrate deploy
```

Then re-run from step 1.

A fresh validator is the right answer 90% of the time — it's faster than tracking down which side of the deposit/withdraw round-trip drifted.
