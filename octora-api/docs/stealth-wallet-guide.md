# Stealth Wallet Guide

## What is a Stealth Wallet?

A stealth wallet is a **fresh, random Solana keypair** that has zero connection to your main wallet. It's used to interact with Meteora LP positions so that on-chain observers cannot link your LP activity back to your identity.

The privacy comes from the **mixer** — not the wallet derivation. The stealth wallet is just the recipient address that the mixer pays out to.

---

## Quick Start

### Generate a Stealth Wallet

```typescript
import { generateStealthWallet } from "#modules/relayer";

const stealth = generateStealthWallet();

console.log(stealth.publicKey);  // e.g. "EQLnENYS..."
console.log(stealth.keypair);    // full Solana Keypair (can sign txs)
console.log(stealth.seed);       // 32-byte Buffer (DO NOT expose)
```

This creates a completely random keypair. No derivation, no link to any other wallet.

---

### Encrypt the Seed for Safe Storage

The seed is sensitive — it controls the stealth wallet's funds. Encrypt it using a key that only the user can reproduce: their wallet signature.

```typescript
import { encryptSeed } from "#modules/relayer";

// User signs a fixed message with their connected wallet (Phantom, Solflare, etc.)
const message = new TextEncoder().encode("octora-vault-key");
const signature = await wallet.signMessage(message); // 64-byte Ed25519 signature

// Encrypt the stealth seed
const encrypted = encryptSeed(stealth, signature);

// Safe to store (backend DB, localStorage, etc.)
console.log(encrypted);
// {
//   ciphertext: "6922c17ca064...",
//   iv: "14f777cdea6a...",
//   authTag: "9eb54cc2d765...",
//   publicKey: "EQLnENYS..."
// }
```

**What's stored:** AES-256-GCM encrypted blob. Useless without the user's signature.

---

### Recover a Stealth Wallet

When the user needs their stealth wallet back (e.g. to claim LP rewards or withdraw):

```typescript
import { decryptSeed } from "#modules/relayer";

// User signs the same message again
const message = new TextEncoder().encode("octora-vault-key");
const signature = await wallet.signMessage(message);

// Decrypt → full keypair recovered
const recovered = decryptSeed(encrypted, signature);

console.log(recovered.publicKey);  // same as original
console.log(recovered.keypair);    // can sign transactions again
```

**Why this works:** Ed25519 signatures are deterministic — same message + same wallet = same signature every time.

---

## API Reference

### `generateStealthWallet(): StealthWallet`

Generate a fresh random stealth wallet.

**Returns:**
```typescript
{
  publicKey: string;      // Base58 Solana address
  keypair: Keypair;       // Full signing keypair
  seed: Buffer;           // 32-byte secret seed
}
```

---

### `encryptSeed(wallet, encryptionKey): EncryptedSeed`

Encrypt a stealth wallet's seed for storage.

**Parameters:**
- `wallet` — The stealth wallet to encrypt
- `encryptionKey` — `Uint8Array` (at least 32 bytes). Use the user's wallet signature.

**Returns:**
```typescript
{
  ciphertext: string;   // Hex-encoded encrypted seed
  iv: string;           // Hex-encoded initialization vector
  authTag: string;      // Hex-encoded GCM authentication tag
  publicKey: string;    // The stealth address (for identification)
}
```

---

### `decryptSeed(encrypted, encryptionKey): StealthWallet`

Decrypt a stored seed and recover the stealth wallet.

**Parameters:**
- `encrypted` — The `EncryptedSeed` blob from `encryptSeed`
- `encryptionKey` — Same key used to encrypt (user signs same message)

**Returns:** `StealthWallet` (same as `generateStealthWallet`)

**Throws:** If the key is wrong or the blob is tampered with (GCM auth check fails).

---

### `recoverStealthWallet(seed): StealthWallet`

Recover directly from a raw 32-byte seed (when you already have it in memory).

**Parameters:**
- `seed` — `Buffer` (exactly 32 bytes)

---

## Security Considerations

### What to store

| Data | Where | Safe? |
|------|-------|-------|
| `EncryptedSeed` blob | Backend DB or localStorage | Yes — encrypted |
| Raw `seed` | NEVER persist | Only in memory during active use |
| User's signature | NEVER persist | Re-derive on demand |

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Backend DB leaked | Encrypted blobs are useless without user's wallet signature |
| User's wallet compromised | Attacker can decrypt stealth seeds — but can't link them on-chain without mixer knowledge |
| Relayer compromised | Relayer only sees stealth public keys, never seeds |
| On-chain observer | Sees mixer deposit + unrelated withdrawal to stealth address — no link |

### Why not derive from main wallet?

We considered HMAC derivation (`HMAC(mainSecret, nonce) → seed`) but rejected it:

1. **Wallet adapters never expose `secretKey`** — Phantom/Solflare only offer `signMessage` and `signTransaction`
2. **Mathematical link** — even off-chain, the derivation creates a traceable relationship
3. **Single point of failure** — main wallet compromised = all stealth wallets exposed
4. **Fresh random is simpler** — the mixer already provides the privacy guarantee

---

## Integration with the Privacy Flow

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  Generate  │────▶│  Encrypt  │────▶│   Store   │────▶│  Recover  │
│  Stealth   │     │   Seed    │     │   Blob    │     │  When     │
│  Wallet    │     │           │     │           │     │  Needed   │
└───────────┘     └───────────┘     └───────────┘     └───────────┘
      │                                                       │
      │ publicKey used as                                     │ keypair used to
      │ withdrawal recipient                                  │ sign LP txs
      │ in ZK proof                                          │ on Meteora
      ▼                                                       ▼
┌───────────┐                                         ┌───────────┐
│   MIXER   │                                         │  METEORA  │
│ Withdraw  │────── SOL flows to stealth ──────────▶│    LP     │
└───────────┘                                         └───────────┘
```

### In the position lifecycle:

1. **Create position intent** → `generateStealthWallet()`
2. **User approves** → `encryptSeed(stealth, signature)` → store blob
3. **Mixer withdrawal** → relayer sends SOL to `stealth.publicKey`
4. **LP active** → stealth keypair signs Meteora transactions
5. **Claim/withdraw** → `decryptSeed(blob, signature)` → use keypair
6. **Exit** → funds route back through mixer

---

## Testing

Run the stealth wallet tests:

```bash
npx vitest run src/modules/relayer/__tests__/stealth-wallet.test.ts
```

Quick smoke test:

```bash
node --import tsx/esm --no-warnings --input-type=module -e "
import { generateStealthWallet, encryptSeed, decryptSeed } from '#modules/relayer';
import { randomBytes } from 'node:crypto';

const stealth = generateStealthWallet();
console.log('Generated:', stealth.publicKey);

const key = randomBytes(64); // simulates wallet signature
const encrypted = encryptSeed(stealth, key);
console.log('Encrypted:', encrypted.ciphertext.slice(0, 20) + '...');

const recovered = decryptSeed(encrypted, key);
console.log('Recovered:', recovered.publicKey);
console.log('Match:', recovered.publicKey === stealth.publicKey);
"
```
