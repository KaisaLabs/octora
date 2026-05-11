# Relayer KMS / signing service

**Why this matters:** the relayer signs every withdraw transaction the mixer accepts. If the relayer keypair leaks, an attacker can:
- Drain the relayer's gas float (small, ≤ a few hundred dollars).
- Submit withdraws on behalf of users (annoying but not a fund-loss for users — the recipient is bound in the proof).
- Censor users by sitting on their proofs.
- Privacy-attack users by correlating proof submissions with timing.

Today the keypair lives on the API host (file-based or inline JSON in env). For mainnet, this is unacceptable: a single VM compromise = relayer key compromise.

**Closes:** P0-21 (relayer keypair off API host), part of P1-44 (balance alarms).

## Decision: AWS KMS vs separate signing VM

| Approach | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| **AWS KMS custom key with `Sign` permission** | Fast to set up (hours), no infra to maintain, audit log built-in, per-request IAM policy | AWS lock-in, latency added per signature (~50 ms), KMS does ECDSA on `secp256k1` natively — Solana's `ed25519` requires either KMS asymmetric `ECC_NIST_P256` (wrong curve) OR using KMS to wrap an ed25519 key stored elsewhere | **For MVP: use KMS to encrypt-at-rest the ed25519 key**, decrypt-on-startup into memory. See "Hybrid pattern" below. |
| **Separate signing VM with mTLS** | Full control over crypto, no curve mismatch, kernel keyring isolation possible | More moving parts, more attack surface than KMS, requires you to operate it | Use only if you have ops capacity. |
| **GCP Cloud HSM with ed25519 key** | Native ed25519 support | GCP-only; if you're already on AWS, adds a cloud | Use if you're already a GCP shop. |

**MVP recommendation: hybrid AWS KMS pattern.** Store the ed25519 keypair encrypted at rest in AWS Secrets Manager with a KMS-encrypted blob; decrypt on relayer startup; key material lives in process memory only. Adds 0 ms steady-state latency, retains the "key never on disk" property, and is reachable in 1 day.

If you can spend an extra week, switch to a true HSM-backed signer (GCP Cloud HSM ed25519 or YubiHSM 2 with ed25519).

## Hybrid AWS pattern — step by step (recommended for MVP)

### 1. Generate keypair offline

On an air-gapped or freshly-booted machine you control:

```
solana-keygen new --no-bip39-passphrase --outfile /tmp/octora-relayer-mainnet.json
```

Record the public key. Do not transfer this file over a network.

### 2. Create AWS KMS customer-managed key

In the AWS region where the API runs:

```
aws kms create-key \
  --description "Octora relayer keypair encryption key" \
  --key-usage ENCRYPT_DECRYPT \
  --customer-master-key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=service,TagValue=octora-relayer
```

Record the key ARN.

Create an alias:
```
aws kms create-alias \
  --alias-name alias/octora-relayer \
  --target-key-id <key-id>
```

### 3. Encrypt the keypair JSON

```
aws kms encrypt \
  --key-id alias/octora-relayer \
  --plaintext fileb:///tmp/octora-relayer-mainnet.json \
  --output text --query CiphertextBlob > /tmp/octora-relayer-mainnet.enc
```

### 4. Store ciphertext in Secrets Manager

```
aws secretsmanager create-secret \
  --name octora/relayer/mainnet \
  --secret-string file:///tmp/octora-relayer-mainnet.enc \
  --tags Key=service,Value=octora-relayer
```

### 5. Wipe local copies

```
shred -u /tmp/octora-relayer-mainnet.json
shred -u /tmp/octora-relayer-mainnet.enc
```

If you used Solana CLI `solana-keygen new` and accepted the seed phrase prompt, also overwrite the seed phrase backup if you took one electronically. The keypair is now only retrievable by something that can both read the secret AND call `kms:Decrypt` with the customer-managed key.

### 6. IAM role for the API EC2 instance

Create an IAM role attached to the API VM (or ECS task) with:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:octora/relayer/mainnet-*"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY-ID"
    }
  ]
}
```

Anything else cannot decrypt the relayer key. CloudTrail logs every `Decrypt` call with the calling principal — so any unauthorized attempt is visible in audit logs.

### 7. Wire the API

Engineer A's work in `octora-api/src/common/config.ts`:

```ts
const SIGNER_KIND = process.env.RELAYER_SIGNER_KIND ?? 'file';

let relayerKeypair: Keypair;

if (SIGNER_KIND === 'kms') {
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const ciphertext = await sm.send(new GetSecretValueCommand({
    SecretId: 'octora/relayer/mainnet',
  }));
  const kms = new KMSClient({ region: process.env.AWS_REGION });
  const decrypted = await kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertext.SecretString!, 'base64'),
  }));
  relayerKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(decrypted.Plaintext!.toString())),
  );
} else if (SIGNER_KIND === 'file') {
  // existing file path; keep for dev/staging
  relayerKeypair = loadFromFile(process.env.RELAYER_KEYPAIR_PATH);
}
```

Set `RELAYER_SIGNER_KIND=kms` in production env via Doppler.

Sets up cleanly without removing the file path code (which staging still uses).

## Wallet segregation

Run **two** separate KMS-encrypted secrets:

| Wallet | Use | Float | KMS key | Secret name |
| --- | --- | --- | --- | --- |
| `octora-mixer-relayer` | Signs `mixer.withdraw` txs (gas only) | ≤ $500 worth of SOL | `alias/octora-mixer-relayer` | `octora/relayer/mainnet-mixer` |
| `octora-executor-relayer` | Signs `executor.dlmm_*` fee-payer slot | ≤ $500 worth of SOL | `alias/octora-executor-relayer` | `octora/relayer/mainnet-executor` |

Two keys, two secrets. Compromise of one does not give access to the other. If you want a third for `mixer-fee-collector` (the wallet that receives relayer fees), add it.

## Balance-change alarm (the bit that makes you sleep)

For each wallet, a CloudWatch alarm:

- Metric: `Custom/Octora/RelayerBalance` published by a 60-second cron in the API:
  ```ts
  const lamports = await connection.getBalance(relayerKeypair.publicKey);
  await cloudwatch.putMetricData({ ... value: lamports / 1e9 });
  ```
- Alarm 1: balance < 0.5 SOL → P3 → email (refill needed).
- Alarm 2: balance dropped > 50% in 10 minutes → P1 → PagerDuty.
- Alarm 3: balance dropped > 90% in 1 hour → P0 → PagerDuty + page operator + auto-trigger pause via Squads (operational decision, not automated for MVP).

Wire CloudWatch → SNS → PagerDuty. PagerDuty has an integration for SNS.

## Refill procedure

Document in `runbooks/incident/relayer-refill.md`:

1. Check Sentry / dashboards for any signs of compromise (unusual signatures, IP origin, etc.).
2. If clean: send SOL from operational treasury to the relayer pubkey. Confirm balance.
3. If suspect: pause via Squads first, investigate, **rotate the key** (see below) before resuming.

## Key rotation

Every 90 days, even with no incident:

1. Generate new keypair offline (Step 1 above).
2. Encrypt and store in a new secret (`octora/relayer/mainnet-mixer-v2`).
3. Update Doppler `RELAYER_KEYPAIR_SECRET_NAME=octora/relayer/mainnet-mixer-v2`.
4. Restart relayer; confirm new pubkey in Sentry.
5. Drain old relayer wallet to operational treasury (residual gas).
6. Delete old secret (`aws secretsmanager schedule-deletion --recovery-window-in-days 7`).
7. Rotate the KMS key per AWS best practice (annual minimum).

If rotated due to a suspected incident: also pause programs via Squads during the rotation, drain the compromised wallet immediately, then resume.

## Disaster recovery

If both KMS access and Secrets Manager access are lost:

- The relayer cannot sign new withdraws.
- **User funds are NOT at risk** — they are in `octora-mixer` PDAs, retrievable by any relayer with valid proofs.
- Fallback: spin up a temporary file-based relayer in an isolated environment with a fresh keypair, fund it, and have the API switch to it via `RELAYER_SIGNER_KIND=file` for the duration. Document in `runbooks/incident/kms-loss.md`.

User experience during DR: withdraws are queued, they fail until the new relayer is live. Send a status-page update.

## Reference

- AWS KMS docs: https://docs.aws.amazon.com/kms/
- Existing `runbooks/deployment/key-rotation.md` — current manual procedure (the file-based one); this doc supersedes it for mainnet.
- Existing `octora-api/src/common/config.ts` — current `loadRelayerKeypair()`; engineer A modifies this.
