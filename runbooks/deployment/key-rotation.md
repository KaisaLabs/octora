# Relayer hot-wallet rotation (P1-45)

**Status:** Authoritative procedure for rotating either of the two relayer hot wallets without a service outage.
**Last updated:** 2026-05-10.
**Cadence:** every 30 days during private beta; quarterly afterwards.

## Scope

Octora runs two distinct hot wallets — keep them logically separated even when both happen to live on the same KMS:

| Wallet | Purpose | Float ceiling | Env var |
| --- | --- | --- | --- |
| `mixer-relayer` | Pays gas for Groth16 withdrawal txs and earns the per-withdrawal fee | $500 (≤ 2.5 SOL) | `OCTORA_MIXER_RELAYER_HOT_WALLET` |
| `executor-relayer` | Funds Anchor CPI tx submission for the on-chain executor | $200 (≤ 1 SOL) | `OCTORA_EXECUTOR_RELAYER_KEYPAIR` |

Both wallets follow the same rotation procedure. Do them one at a time, not both in the same window — rolling the executor wallet during a busy mixer window is exactly the kind of orchestrated downtime we're trying to avoid.

## When to rotate

- **Scheduled** — every 30 days for the private beta. The first rotation is one week after the mainnet deploy.
- **Suspected compromise** — anyone with shell access to the API host left the team, or alerts fired that the wallet was draining unexpectedly. Rotate within the hour.
- **Balance anomaly** — the CloudWatch / PagerDuty alert "balance change > $X within Y minutes" tripped. Rotate within the hour even if the cause is benign — never sit on a noisy alarm by silencing it.

## Pre-flight (~ 5 min)

1. Confirm `/health` is green and `/metrics` returns the current relayer balance.
2. Note the current wallet's pubkey + balance for the post-rotation reconciliation.
3. Open a deploy ticket so the rotation is auditable. Title: `relayer-key-rotation YYYY-MM-DD <wallet-name>`.

## 1. Provision the new keypair

Run on the hardened operator laptop (NOT the API host):

```bash
solana-keygen new --no-bip39-passphrase -o /tmp/relayer-new.json
solana address -k /tmp/relayer-new.json
```

If you're using a KMS-backed signing service (the audit's eventual recommendation, P0-21):

```bash
# Example for AWS KMS — adapt to your provider.
aws kms create-key --description "octora-mixer-relayer-$(date +%Y%m%d)" \
  --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY
# Capture the KMS key ARN; the signing service maps it to a Solana pubkey.
```

The new pubkey goes into the deploy ticket. The keypair file (or KMS ARN) goes into the secrets manager — never check it into git, never paste it into Slack.

## 2. Pre-fund the new wallet

Send the new wallet enough SOL for ~24 hours of expected gas + fees + a safety buffer. Use the team treasury, not the personal deploy keypair. Wait for confirmation:

```bash
solana balance <NEW_PUBKEY>
# Must equal the funded amount before continuing.
```

Under-funding is the #1 way a key rotation causes downtime. Over-fund slightly — you'll drain the surplus back at the end.

## 3. Drain-warm the new wallet (one canary tx)

Submit a single trivial transaction signed by the new key (memo program with a unique tag) so the wallet has a confirmed history slot before it's load-bearing. This avoids a cold-start "first tx is slow" surprise the moment you flip env vars.

```bash
solana transfer <SQUADS_VAULT_PDA> 0.0001 \
  --from /tmp/relayer-new.json \
  --allow-unfunded-recipient false
```

## 4. Update secrets

In the production secrets manager:

1. Edit `OCTORA_MIXER_RELAYER_HOT_WALLET` (or `OCTORA_EXECUTOR_RELAYER_KEYPAIR`) to point at the new key. Inline JSON byte array OR `file:<absolute-path>` per `octora-api/src/common/config.ts`.
2. Save. Do NOT roll out yet.

Keep the OLD key still on the deployed pods so in-flight txs can finish — we cut over via a deploy in the next step, not by yanking the env var.

## 5. Roll out

The exact mechanism depends on the host:

- **Fly.io** — `flyctl secrets set OCTORA_MIXER_RELAYER_HOT_WALLET=<new>` triggers a rolling restart of API machines. Watch `flyctl logs` for the "mixer relayer initialized" line on each machine; pubkey in that log line must equal the new pubkey.
- **Render / ECS / single VM** — apply the env-var change, then trigger a deploy. Same verification: confirm the boot log mentions the new pubkey on every replica.
- **Local docker compose** — `docker compose up -d --force-recreate octora-api`.

After the rolling restart, every replica must be using the new key. There is no version of this where one replica still has the old key for "just a few minutes" — that's the path that turns a routine rotation into a multi-key incident.

## 6. Verify in flight

Within ~5 minutes of rollout:

- [ ] `/health` is green with `relayer.ok = true` (the health probe verifies the keypair file decrypts and is 64 bytes).
- [ ] `/metrics` reports `relayer.publicKey` equal to the new pubkey.
- [ ] One real withdrawal lands and Sentry stays quiet.
- [ ] The new pubkey appears as `signer` on the latest withdrawal tx (`solana confirm <SIG>`).

If any of those fail, **roll back the secret** to the old key first, then debug. Don't try to fix forward on a load-bearing wallet.

## 7. Drain the old wallet

Once the new wallet is confirmed handling traffic AND no in-flight signatures depend on the old one (give it 10 minutes), sweep:

```bash
solana transfer <NEW_PUBKEY> ALL \
  --from <OLD_KEYPAIR_PATH_OR_KMS_REF> \
  --allow-unfunded-recipient false
```

A balance of `0` on the old key is the success signal. Anything else means a tx still has the old key as fee payer — investigate before disposing.

## 8. Dispose of the old keypair

Same options as for the deploy keypair (see `upgrade-authority.md` §4):

1. **Sealed offline.** Move the JSON to `1Password → Octora / Mainnet / Relayer Keys (RETIRED)`, tag with rotation date.
2. **Destroyed.** `shred -u <keypair.json>` on a Linux machine.

For KMS-backed keys, schedule the old key for destruction with the appropriate cooldown (AWS KMS: 7-30 days). Document the scheduled destruction date in the deploy ticket.

## 9. Update the operational dashboard

- Update the "Current relayer pubkey" entry in the team handbook so on-call knows what address to whitelist on Helius / Triton.
- Update the alert threshold inputs (low-balance threshold scales off the new wallet's funded amount, not the previous one).

## 10. Close the ticket

- Paste pre- and post-rotation balances.
- Paste the canary tx + first real tx signatures.
- Note the disposition of the old key (sealed / destroyed).
- Schedule the next rotation in the on-call calendar (30 days out).

## What to do if rotation fails mid-flight

| Symptom | Action |
| --- | --- |
| New replica boots with the new key but `/health` shows `relayer.ok=false` | Roll back the secret to the old key, redeploy. Investigate format (file path? inline array?). |
| One replica still on old key after rollout (split-brain) | Force-recreate that replica. Don't proceed until pubkey is uniform across replicas. |
| Withdrawal txs land but Sentry shows duplicate-payer errors | Old and new keys both present in env; one is being picked up randomly. Stop traffic via `set_paused = true` on the mixer, then converge to the new key. |
| Old key drained but new key isn't receiving credit | Treasury transfer to the wrong pubkey. Pause the relayer until balances reconcile — the relayer fail-closes when the hot wallet is empty (low_balance health check). |

If you need to pause the mixer during the rotation, do it from the Squads UI (`octora_mixer.set_paused(true)`). The pause is the only safe knob you control while the keys are in flux.
