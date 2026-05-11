# Solo-operator quickstart — Octora mainnet closed beta

**Audience:** you, by yourself, deploying Octora to mainnet for ~10 manually-selected beta testers.

**This is NOT the full launch runbook.** The other docs in this folder are written for a team launching to public users — they cover Squads multisigs, KMS-backed signers, paid alerting stacks, sanctions screening, and so on. For a closed beta where you know every tester by name, most of that machinery is overkill and can be deferred until you decide to open signups. This quickstart picks the minimum-viable subset and gives you concrete commands.

**Scope guardrails before you start:**

- 10 testers max. You manually share the URL with each one.
- TVL cap conservative — start at `BETA_MAX_POSITION_SOL=1` and `BETA_MAX_GLOBAL_TVL_SOL=20`. Bump after a successful week.
- You hold the upgrade authority and the admin authority on a single keypair. Acceptable single-point-of-failure for 10 known testers, NOT for public launch. Plan to transfer to Squads before you open the doors wider.
- Skipping multisig and KMS is a *deferred* decision, not a "don't bother." Both are documented in `01_SQUADS_MULTISIG.md` and `03_RELAYER_KMS.md` — read those before you go public.

**Time estimate end-to-end: ~7-10 days, gated by the ceremony scheduling and the RPC procurement signup.**

---

## What you need to do (in dependency order)

| # | Task | Time | Cost | Blocker for | Section |
| --- | --- | --- | --- | --- | --- |
| 1 | Mainnet RPC signup | 30 min (signup) + 1-3 days (provisioning) | $200-500/mo first month | Everything | §1 |
| 2 | Trusted-setup ceremony scheduling | 30 min (book contributors) | $0 | Mixer deploy | §2 |
| 3 | Generate keypairs (deploy payer, admin authority, program IDs, relayer hot wallet) | 30 min | $0 | Source patches | §3 |
| 4 | Fund the deploy payer wallet | 5 min | ~5 SOL (~$1k at $200/SOL) | Deploy day | §4 |
| 5 | Production Postgres database | 30 min | $0-$25/mo | API runtime | §5 |
| 6 | Run the trusted-setup ceremony | half a day | $0 | Mixer deploy | §6 |
| 7 | Hand off keypair pubkeys + ceremony output to engineering | 10 min | $0 | Source patches | §7 |
| 8 | Wait for source patches (mine) | ~2 hours (mine) | $0 | Devnet smoke | §8 |
| 9 | Devnet smoke test | 1-2 hours | ~0.5 SOL devnet (free) | Mainnet deploy | §9 |
| 10 | Mainnet deploy day | 1-2 hours | ~5 SOL gas | — | §10 |

---

## §1. Mainnet RPC signup

You need a paid RPC because public mainnet-beta will rate-limit you mid-flow and drop transactions. For 10 testers, **a single Helius Developer plan is enough**; you don't need the separate-endpoint-per-role split the launch runbook describes.

### Steps

1. Go to `https://helius.dev` → Sign up.
2. Pick **Developer plan** (~$199/mo). Free tier exists but the per-second limits will bite during a deposit flow's burst of RPC calls.
3. Create a new API key labeled `octora-mainnet-beta`.
4. Copy the **mainnet RPC URL** — it looks like `https://mainnet.helius-rpc.com/?api-key=<KEY>`.
5. Optional but recommended: enable **enhanced priority-fee API** in the dashboard. The submit-confirmed helper uses it on retry.

### Alternative
If you already have an account at Triton, QuickNode, or Alchemy, any will work. The code only needs a URL that accepts standard JSON-RPC and `getSignaturesForAddress` without aggressive pagination limits.

### What "done" looks like
You have a URL string starting with `https://`. Save it somewhere encrypted (1Password, your secrets manager). You will paste it into env vars on deploy day.

### Time
30 min for signup. Helius issues keys immediately. Some providers (Triton) take 1-3 business days for provisioning — start this Day 1.

---

## §2. Schedule the ceremony contributors

The trusted-setup ceremony for the mixer's withdraw circuit needs **≥3 independent contributors**. This is the long-lead-time item — start scheduling NOW even though you'll run it later.

See `02_TRUSTED_SETUP_CEREMONY.md` for the full mechanics. For your beta, the abbreviated brief:

### Pick contributors

- **You + 2 trusted technical people** (friends, advisors, fellow founders).
- **Different machines, different OS where possible, different physical locations.** Two people in the same room with the same laptop image = one contributor pretending to be two.
- **NOT the same people as your Squads signers** (which you'll add later for the open beta). Defense in depth.

### Brief each contributor (DM template)

> Hey [name],
>
> I'm launching a Solana privacy product (Octora) to a small closed beta. The mixer uses a Groth16 zk-SNARK, which needs a multi-party trusted setup ceremony before mainnet — basically each of us takes turns contributing entropy to the proving/verifying key, and **as long as at least one of us destroys their entropy properly, no one can forge proofs and drain the mixer.**
>
> What you'd do:
> 1. About **30 minutes of your time**, on a date we coordinate over the next ~10 days.
> 2. Run a script on your laptop that mixes in entropy from your machine.
> 3. Publish a transcript file + hash to a public attestation channel.
> 4. **Destroy the toxic-waste file from your machine immediately after** (the script outputs it; you `rm` it and confirm).
>
> Can you do it? If yes, I'll send a date, the script, and a screen-share so we can walk through it together.

### Pick a date
Pick a Saturday morning ~7-10 days out. Hold the date even if other things slip.

### Time
30 min to write the DMs. The actual ceremony is §6 below.

---

## §3. Generate keypairs

You need **5 distinct keypairs** for mainnet. Each has a different purpose and you should NOT reuse keys across roles.

| # | Keypair | Role | Where it lives |
| --- | --- | --- | --- |
| 1 | Deploy payer | Pays the ~5 SOL for `solana program deploy` | Hardware wallet or hardened laptop, online during deploy day only |
| 2 | Admin authority | Pauses pools, signs `init_config` and `initialize`. Will be the `EXECUTOR_ADMIN_AUTHORITY` + mixer `ADMIN_AUTHORITY` constant. | Hardware wallet recommended; keep this offline outside admin actions |
| 3 | Executor program ID | Owns the `octora-executor` program | Never used after deploy. Sealed, offline, never touched. |
| 4 | Mixer program ID | Owns the `octora-mixer` program | Same |
| 5 | Relayer hot wallet | Pays gas for every relayer-submitted withdraw | Lives on the API host. Funded with ≤$500 worth of SOL. |

### Commands

```bash
mkdir -p ~/octora-keys/mainnet
cd ~/octora-keys/mainnet

# 1. Deploy payer (you'll fund this in §4)
solana-keygen new --no-bip39-passphrase -o deploy-payer.json

# 2. Admin authority — if you have a Ledger, use that instead
solana-keygen new --no-bip39-passphrase -o admin-authority.json

# 3. Executor program ID
solana-keygen new --no-bip39-passphrase -o octora-executor.json

# 4. Mixer program ID
solana-keygen new --no-bip39-passphrase -o octora-mixer.json

# 5. Relayer hot wallet
solana-keygen new --no-bip39-passphrase -o relayer-hot.json

# Capture pubkeys
echo "--- pubkeys ---"
echo "deploy-payer:      $(solana address -k deploy-payer.json)"
echo "admin-authority:   $(solana address -k admin-authority.json)"
echo "executor-program:  $(solana address -k octora-executor.json)"
echo "mixer-program:     $(solana address -k octora-mixer.json)"
echo "relayer-hot:       $(solana address -k relayer-hot.json)"
```

### Storage rules

- **`octora-executor.json` and `octora-mixer.json`**: never touched after deploy. Burn to a USB drive, store in a safe deposit box, or import to 1Password's secure file storage. Two copies, two locations. If you lose these you cannot upgrade the program ever again.
- **`admin-authority.json`**: hardware wallet ideally. If software, put it on a separate machine you do not browse the web on.
- **`deploy-payer.json`**: same machine you'll use for deploy day. Fund only what's needed.
- **`relayer-hot.json`**: lives on the API host. NOT in git. NOT in any logging output.

### What "done" looks like

Five keypair JSON files exist on your laptop, you have all five pubkeys written down, and you've backed up the two program-ID files (#3 and #4) to a separate device.

### Time
30 minutes including the backup step.

---

## §4. Fund the deploy payer

The deploy payer needs **at least 5 SOL** to cover `solana program deploy` for both programs (~2 SOL each plus headroom). At $200/SOL, that's ~$1,000.

Send SOL to the pubkey from §3 row 1. Verify:

```bash
solana balance -k ~/octora-keys/mainnet/deploy-payer.json -u <YOUR_HELIUS_RPC>
```

You should see `5 SOL` or more.

### Time
5 minutes once you have SOL somewhere.

---

## §5. Production Postgres

The API's relayer needs Postgres for the `MixerRootSeen` table that powers the privacy-delay gate. Without this, the relayer falls back to no delay enforcement — every withdraw passes immediately, which collapses the anonymity guarantee against a timing-correlation attacker.

### Cheapest option: Supabase or Neon free tier

Both have a free Postgres tier that's plenty for a 10-tester beta (the table only writes once per unique Merkle root).

```bash
# 1. Sign up at supabase.com (or neon.tech)
# 2. Create a project labeled "octora-mainnet-beta"
# 3. Pick a region close to your API host
# 4. Copy the "connection string" — it looks like:
#    postgresql://postgres:[YOUR-PASSWORD]@db.[ref].supabase.co:5432/postgres
```

Save this string. It will be `DATABASE_URL` on the API.

### Apply migrations

```bash
cd octora-api
DATABASE_URL='postgresql://...' pnpm prisma migrate deploy
```

The `MixerRootSeen` table (and the rest of the Prisma schema) gets created.

### Time
30 minutes.

---

## §6. Run the trusted-setup ceremony

This is the actual ceremony, on the date you scheduled in §2.

### Pre-flight (you, alone, 1 hour before)

1. **Re-verify the circuit is final** by checking out the deploy commit:
   ```bash
   cd octora-api
   git log -1 -- src/modules/vault/circuits/withdraw.circom
   ```
   If any commit touched the circuit AFTER the commit you plan to deploy, the ceremony you're about to run will be invalid. Stop and resolve.

2. **Generate the starting `.ptau` (Phase 1 universal setup)**:
   ```bash
   cd octora-api/src/modules/vault/circuits
   # Use Hermez's public Phase 1 file if you trust their ceremony, or
   # generate a fresh one with snarkjs powersoftau.
   # For BN254 + 2^17 constraints (more than enough for our circuit):
   curl -sLO https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_17.ptau
   ```
   The Hermez Phase 1 ceremony is publicly auditable. You don't need to redo Phase 1.

3. **Compile the circuit to r1cs + witness generator** if not already in `build/`:
   ```bash
   pnpm run build:circuit  # or equivalent script for your repo
   ```

4. **Run Phase 2 setup-start**:
   ```bash
   snarkjs groth16 setup withdraw.r1cs powersOfTau28_hez_final_17.ptau \
     withdraw_0000.zkey
   ```
   This is the input each contributor will mix into.

### Ceremony (you + contributors, ~45 min on the call)

Each contributor (you first, then each other one) runs a SINGLE command on their machine that:
1. Takes the previous `.zkey` (you send them yours).
2. Mixes in entropy from `/dev/urandom` + a passphrase they type.
3. Outputs a NEW `.zkey` they send back to you.
4. **Then they MUST `rm` their working directory** to destroy the toxic-waste intermediate.

The contributor command (paste into the screen-share):

```bash
# As contributor N, you receive withdraw_000<N-1>.zkey from the operator.
# Replace <N> with your contributor number (1, 2, or 3...).

snarkjs zkey contribute \
  withdraw_000<N-1>.zkey \
  withdraw_000<N>.zkey \
  --name="Contributor <N>: $(whoami)@$(hostname) — $(date -u)" \
  -v

# snarkjs will prompt for entropy — type 30+ characters of random keyboard mash.

# Verify the contribution:
snarkjs zkey verify withdraw.r1cs powersOfTau28_hez_final_17.ptau withdraw_000<N>.zkey

# Once verified, send withdraw_000<N>.zkey back to the operator,
# then immediately delete your working copy + entropy:
rm withdraw_000<N-1>.zkey  # remove the input
shred -uvz ~/.ssh/contribute-entropy* 2>/dev/null || true
history -c
echo "Done. Contribution sent."
```

You collect each contributor's output and forward the latest `.zkey` to the next contributor. After the last contributor, you have `withdraw_000<N>.zkey` where N = number of contributors.

### Finalize

```bash
# Apply the random beacon (a public hash with no preimage knowledge —
# use a recent Bitcoin block hash or Ethereum block hash).
BEACON=$(curl -s https://api.blockchain.info/q/latesthash)
echo "Beacon (lock this in your transcript): $BEACON"

snarkjs zkey beacon withdraw_000<N>.zkey withdraw_final.zkey \
  $BEACON 10 \
  --name="Final beacon: BTC block $BEACON"

# Export the verifying key
snarkjs zkey export verificationkey withdraw_final.zkey verification_key.json

# Generate Solidity-style verifier bytes (we need these for the Rust verifier)
snarkjs zkey export solidityverifier withdraw_final.zkey verifier.sol
# Extract the alpha/beta/gamma/delta/IC bytes — you'll hand these to engineering.
```

### Publish transcripts

Create a public attestation:
1. Each contributor publishes their contribution hash + a signed message attesting they destroyed their entropy. Format:
   ```
   Contributor: <name>
   Public key: <solana or other public id>
   Contribution hash: <output of `snarkjs zkey contribute --print`>
   Beacon used: <BTC block hash from finalize>
   Attestation: "I confirm I generated entropy from /dev/urandom + keyboard input and destroyed
   the working directory after my contribution. Signed, <name>, <date>."
   ```
2. Commit these to `runbooks/ceremony/transcripts/contributor-<N>.txt` in the repo.
3. Commit `verification_key.json` and `withdraw_final.zkey` to the repo (these are public outputs).

### What "done" looks like

You have:
- `octora-api/src/modules/vault/circuits/build/withdraw_final.zkey`
- `octora-api/src/modules/vault/circuits/build/verification_key.json`
- `runbooks/ceremony/transcripts/contributor-1.txt` through `contributor-N.txt`

### Time
Half a day to organize, ~45 min on the actual ceremony call.

---

## §7. Hand off to engineering (me)

Paste these into the Slack/DM channel where we coordinate:

```
=== Octora mainnet handoff ===

Program IDs (from §3):
  Executor: <pubkey>
  Mixer:    <pubkey>

Admin authority pubkey (from §3 row 2): <pubkey>

Mainnet RPC URL (from §1): https://mainnet.helius-rpc.com/?api-key=<KEY>
  (you can keep the key — I won't paste it into source. I need the URL
  shape and any provider-specific quirks, e.g. enhanced-priority-fee on/off.)

Ceremony output:
  - verification_key.json attached
  - withdraw_final.zkey attached (or committed to repo at <path>)

Postgres connection string format (no need to share the password):
  Provider: Supabase / Neon / RDS / ...
  Region:   ...
  Pool mode: transaction (or session)
```

### What I do with this

In one commit on a `deploy/mainnet-<date>` branch:

1. Patch `programs/octora-executor/src/lib.rs::declare_id!` with executor pubkey
2. Patch `programs/octora-mixer/src/lib.rs::declare_id!` with mixer pubkey
3. Patch `programs/octora-executor/src/constants.rs::EXECUTOR_ADMIN_AUTHORITY` with admin pubkey bytes
4. Patch `programs/octora-mixer/src/constants.rs::ADMIN_AUTHORITY` with admin pubkey bytes
5. Patch `programs/octora-mixer/src/verifier/groth16.rs` with the verifying-key bytes from `verification_key.json`
6. Copy `verification_key.json` to `octora-web/src/lib/mixer/verification_key.json` so browser proofs match
7. Uncomment `[programs.mainnet]` in `Anchor.toml`, fill IDs
8. `anchor build` and SHA the `.so` files
9. Regenerate IDLs and sync into `octora-api/src/modules/{execution,relayer}/idl/`
10. Commit it all on the deploy branch and push

### Time
~2 hours my side. You wait.

---

## §8. Devnet smoke test

Before mainnet, deploy the SAME patched commit to devnet and walk all three flows in the UI. **Anything that breaks on devnet will break on mainnet.**

### Steps

1. Switch your `solana-keygen` config to devnet:
   ```bash
   solana config set --url https://api.devnet.solana.com
   ```
2. Airdrop SOL to your deploy payer:
   ```bash
   solana airdrop 5 -k ~/octora-keys/mainnet/deploy-payer.json
   ```
   (Devnet airdrop is free and instant for 1 SOL increments; run it 5 times.)
3. **Deploy to devnet** using the SAME branch I just patched:
   ```bash
   cd <repo>
   git checkout deploy/mainnet-<date>
   anchor build --no-idl
   solana program deploy --program-id ~/octora-keys/mainnet/octora-executor.json \
     -k ~/octora-keys/mainnet/deploy-payer.json \
     -u https://api.devnet.solana.com \
     target/deploy/octora_executor.so
   solana program deploy --program-id ~/octora-keys/mainnet/octora-mixer.json \
     -k ~/octora-keys/mainnet/deploy-payer.json \
     -u https://api.devnet.solana.com \
     target/deploy/octora_mixer.so
   ```
   This uses the SAME program-ID keypairs you'll use for mainnet. They'll be deployed twice (devnet + mainnet) with the same pubkey but to different clusters — perfectly fine.
4. Run `init_config`:
   ```bash
   # Sign with admin-authority since EXECUTOR_ADMIN_AUTHORITY is patched to that pubkey.
   pnpm tsx scripts/init-executor-config.ts  # if you have one; otherwise hand-craft via @coral-xyz/anchor REPL
   ```
5. Run `init-mixer-pools.ts` against devnet:
   ```bash
   SOLANA_RPC_URL=https://api.devnet.solana.com \
   OCTORA_MIXER_PROGRAM_ID=<mixer pubkey> \
   MIXER_DENOMINATIONS=100000000,1000000000,10000000000 \
     pnpm tsx scripts/init-mixer-pools.ts
   ```
6. Start the API pointed at devnet:
   ```bash
   # In octora-api directory, env vars from §10's table but pointed at devnet
   pnpm dev
   ```
7. Start the web frontend:
   ```bash
   cd octora-web
   VITE_API_URL=http://localhost:8787 \
   VITE_RPC_URL=https://api.devnet.solana.com \
     pnpm dev
   ```
8. **In the browser**, with your wallet on devnet:
   1. Set `MIXER_MIN_ANONYMITY_SET=0` in the API env so a fresh pool isn't gated.
   2. Open a position via the PoolDetail page → "Deposit privately" with 0.1 SOL denomination.
   3. Wait for confirmation. You should see the success modal.
   4. Navigate to Position Detail.
   5. Click "Claim privately" — walk all 12 steps.
   6. Click "Exit privately" in the Withdraw tab — walk all 11 steps.
9. If any step fails, screenshot + share the error. I fix, you re-run.

### What "done" looks like

Three green flows on devnet. The position appears in your portfolio after deposit. After exit, the main wallet's SOL balance reflects the credited amount minus mixer + relayer fees.

### Time
1-2 hours, mostly waiting for confirmations.

---

## §9. Mainnet deploy day

Only do this after §8 is green.

### Pre-flight

```bash
# Switch CLI back to mainnet
solana config set --url <YOUR_HELIUS_RPC_URL>
solana config set --keypair ~/octora-keys/mainnet/deploy-payer.json
solana balance   # ≥ 5 SOL

# Verify you're on the deploy branch with the patched constants
cd <repo>
git status
git log -1 --format='%H %s'
```

### Deploy

```bash
# Build (same artifacts you tested on devnet)
anchor build --no-idl
sha256sum target/deploy/octora_executor.so target/deploy/octora_mixer.so
# Pin these SHAs in a deploy notes file or message thread.

# Deploy executor
solana program deploy \
  --program-id ~/octora-keys/mainnet/octora-executor.json \
  target/deploy/octora_executor.so
# Wait for "Program Id: <executor pubkey>"

# Deploy mixer
solana program deploy \
  --program-id ~/octora-keys/mainnet/octora-mixer.json \
  target/deploy/octora_mixer.so
```

### Set upgrade authority

```bash
# For beta: keep upgrade authority on the deploy-payer for now. You can
# transfer to a Squads vault later via `solana program set-upgrade-authority`.
# DO NOT use --final unless you want to permanently freeze upgrades.
```

### Initialize

```bash
# Switch CLI keypair to the admin authority (this signs init_config + init_pool)
solana config set --keypair ~/octora-keys/mainnet/admin-authority.json
solana balance   # this wallet needs ~0.1 SOL for rent

# Init executor Config
pnpm tsx scripts/init-executor-config.ts  # or your equivalent

# Init the three mixer pools
SOLANA_RPC_URL=<helius> \
OCTORA_MIXER_PROGRAM_ID=<mixer pubkey> \
MIXER_DENOMINATIONS=100000000,1000000000,10000000000 \
  pnpm tsx scripts/init-mixer-pools.ts
```

### Fund the relayer hot wallet

```bash
# Send ~2 SOL from a normal wallet to the relayer pubkey.
# This pays for the first ~100-200 user withdrawals at typical priority fees.
# Top up via a 1Password reminder; you'll watch this in monitoring.

solana transfer \
  $(solana address -k ~/octora-keys/mainnet/relayer-hot.json) \
  2 \
  --allow-unfunded-recipient
```

### Set API env vars

On your API host (Fly.io, Railway, fly-replicated, whatever), set:

```
SOLANA_RPC_URL=<helius>
OCTORA_EXECUTOR_PROGRAM_ID=<executor pubkey>
OCTORA_MIXER_PROGRAM_ID=<mixer pubkey>
OCTORA_EXECUTOR_RPC_URL=<helius>
OCTORA_EXECUTOR_RELAYER_KEYPAIR_PATH=/path/to/relayer-hot.json
OCTORA_MIXER_RELAYER_ENABLED=true
OCTORA_MIXER_RELAYER_HOT_WALLET_SECRET=<base64 of relayer-hot.json contents>
   # OR mount it as a file and use _PATH if your platform prefers that
MIXER_DENOMINATIONS=100000000,1000000000,10000000000
OCTORA_MIXER_RELAYER_DENOMINATIONS=100000000,1000000000,10000000000
OCTORA_MIXER_RELAYER_MIN_FEE_LAMPORTS=10000
OCTORA_MIXER_PRIVACY_DELAY_MS=13000
OCTORA_ADMIN_API_TOKEN=<32+ random bytes, base64>
MIXER_MIN_ANONYMITY_SET=20
BETA_MAX_POSITION_SOL=1
BETA_MAX_GLOBAL_TVL_SOL=20
DATABASE_URL=<from §5>
FRONTEND_URL=<your beta web URL, e.g. https://beta.octora.xyz>
SENTRY_DSN=<optional, your Sentry project DSN>
```

Restart the API.

### Set web env vars

On your static-hosting platform (Vercel, Cloudflare Pages, Netlify):

```
VITE_API_URL=<your API URL>
VITE_RPC_URL=<helius>
VITE_SENTRY_DSN=<optional>
```

Rebuild and deploy the frontend.

### Smoke yourself first

Before sharing the URL with any tester:

1. Connect your own wallet.
2. Open a 0.1 SOL position.
3. Wait for confirmation.
4. Exit privately.
5. Confirm main wallet received the SOL minus fees.

If this works, the system is live.

### Open to testers

Share the URL + a one-page "what to expect" note with your 10 testers:
- The flow takes ~10 minutes end-to-end (proof generation + privacy delay).
- The first time they deposit, the wallet pops twice (derive stealth + sign deposit).
- They should screenshot any error and DM you.
- TVL caps in place — they can deposit up to 1 SOL per position.

### Time
1-2 hours.

---

## §10. Things you skipped that you need before public launch

To be crystal clear about the deferred items so you don't forget:

| Deferred | Risk while deferred | When to do it |
| --- | --- | --- |
| Squads multisig holding upgrade authority | A laptop compromise = anyone can deploy malicious upgrades to drain pools | Before opening signups |
| KMS-backed relayer signer | Relayer key compromise → drain gas float (small), submit unwanted withdraws (annoying), censor users (mild) | Before opening signups |
| Lawyer-reviewed ToS | Personal regulatory exposure | Before opening signups |
| Sanctions screening / geo-restrict | Regulatory exposure | Before opening signups |
| 24/7 monitoring + paging | Slow incident response | Before opening signups |

None of these are required for 10 known testers, but they're **all** required before you tell strangers Octora is open.

---

## §11. If something goes wrong

### Pause the system

You have `OCTORA_ADMIN_API_TOKEN`. Use it:

```bash
curl -X POST https://your-api.example.com/admin/executor/pause \
  -H "Authorization: Bearer $OCTORA_ADMIN_API_TOKEN"

curl -X POST https://your-api.example.com/admin/mixer/pause \
  -H "Authorization: Bearer $OCTORA_ADMIN_API_TOKEN" \
  -d '{"denomination": "1000000000"}'  # repeat for each denom
```

The pause flag is on-chain; once flipped, every state-mutating instruction reverts until you flip it back.

### Tell testers

Group DM:
> Hey — I've paused Octora for ~30 min while I look at <issue>. Your funds are safe; the pause prevents any new transactions and the chain state is preserved. I'll post here when it's back up.

### Diagnose

- Sentry: pull up the most recent error grouped by `flow` tag (privateDeposit / privateClaim / privateExit).
- API logs: look for the latest 500.
- On-chain: `solana logs <PROGRAM_ID>` against your RPC.

### Unpause when ready

Same admin endpoints with `paused=false`.

---

## §12. Pre-deploy checklist (print this)

Before you start deploy day, every box must be checked:

- [ ] §1 RPC URL captured + tested with `curl <URL> -d '{"jsonrpc":"2.0","method":"getVersion","id":1}' -H 'Content-Type: application/json'`
- [ ] §2 ceremony date confirmed with all contributors
- [ ] §3 all five keypairs generated, two program-ID files backed up offline
- [ ] §4 deploy payer ≥ 5 SOL on mainnet
- [ ] §5 Postgres reachable, `prisma migrate deploy` ran clean
- [ ] §6 ceremony done, `verification_key.json` + `withdraw_final.zkey` checked into repo, transcripts published
- [ ] §7 pubkeys + ceremony output handed to engineering (me)
- [ ] §8 devnet smoke green — all three flows
- [ ] §9 not yet started

Once §1-§8 are all ✅, §9 is a 1-2 hour exercise.
