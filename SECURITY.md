# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security bugs.**

Email reports to **security@octora.io** (placeholder — replace with the
real address before publishing this file). PGP key available on request.

We aim to:

- Acknowledge receipt within **48 hours**.
- Provide a triage assessment (in-scope / out-of-scope / severity)
  within **5 business days**.
- Ship a fix or mitigation, in coordination with the reporter, within
  the timelines below.

If you have not heard back within 48 hours, please escalate via
[describe alternate channel — Twitter DM, Telegram, etc.].

## Scope

In-scope:

- `programs/octora-mixer/` — on-chain mixer (Anchor program).
- `programs/octora-executor/` — on-chain Meteora wrapper (Anchor program).
- `octora-api/src/modules/relayer/` — off-chain relayer service.
- `octora-api/src/modules/mixer/` — off-chain mixer service.
- `octora-api/src/modules/vault/` — proof verifier, Merkle tree,
  commitment generation.
- `octora-web/src/lib/mixer/` — browser-side prover (when applicable).
- The Phase-2 trusted-setup ceremony transcript and verification
  scripts under `scripts/ceremony/`.

Out-of-scope:

- Bugs in upstream dependencies (`anchor-lang`, `groth16-solana`,
  `circomlib`, Meteora DLMM/DAMM programs, Solana validators). Report
  these to the respective maintainers.
- Bugs in third-party wallets (Phantom, Solflare, Squads UI) used as
  signers for the admin multisig.
- Social engineering of multisig members.
- Issues that require physical access to a contributor's machine
  (this is a documented threat model assumption — see
  `scripts/ceremony/CEREMONY.md`).
- DoS via spamming the public relayer endpoints (rate limits already
  apply; see `octora-api/src/modules/relayer/relayer.routes.ts`).
  Mitigation suggestions are welcome but bounty payouts are reserved
  for higher-severity classes.

## Severity classes

| Severity | Examples | Bounty range (USD) |
|---|---|---|
| **Critical** | Forge a withdrawal proof; drain the mixer pool; bypass nullifier check; recover toxic-waste from the published ceremony transcript | $25,000 – $100,000 |
| **High** | Permanent freeze of admin functions; unauthorized pause; theft of relayer hot-wallet funds; off-chain ↔ on-chain Poseidon divergence enabling replay | $5,000 – $25,000 |
| **Medium** | Griefing the relayer's gas budget; cache poisoning leading to RPC errors; signal-mismatch acceptance; uncovered edge-case panics | $500 – $5,000 |
| **Low** | Doc or comment errors that mislead users; insecure defaults that require explicit opt-in to exploit; rate-limiter bypasses | $0 – $500 |

Bounty amounts above are placeholders — the program will be formalized
on Immunefi or Cantina post-launch with concrete numbers tied to TVL.

## Disclosure timeline

- **Critical / High:** coordinated disclosure within **30 days** of
  initial report, or sooner if a fix lands earlier.
- **Medium:** within **90 days**.
- **Low:** at the maintainer's discretion, typically batched with the
  next release.

We will credit reporters in `CHANGELOG.md` unless they prefer
anonymity.

## Threat model summary

The protocol's security rests on five distinct layers; every layer
must hold for the privacy / integrity guarantees to be maintained:

1. **Groth16 verification key integrity.** Forging proofs requires
   either breaking the discrete-log problem on BN254 or recovering
   the toxic waste from the Phase-2 ceremony. We rely on at least one
   honest contributor in the ceremony; the public transcript and
   `scripts/ceremony/03-verify.sh` allow anyone to confirm the chain.

2. **Circuit correctness.** `withdraw.circom` enforces commitment
   = Poseidon(secret, nullifier), Merkle inclusion of the commitment,
   and binding of the recipient/relayer/fee public inputs. A circuit
   bug is a CRITICAL finding.

3. **On-chain program correctness.** `octora-mixer` and
   `octora-executor` enforce nullifier uniqueness (PDA `init`),
   recipient/relayer/fee parity with the proof, public-input
   field-order range, denomination-vs-fee bounds, and admin gating
   on `initialize` / `set_paused`.

4. **Off-chain ↔ on-chain consistency.** The relayer's pre-checks
   and the browser's prover must produce byte-identical Poseidon
   outputs to the on-chain Solana Poseidon syscall. Divergence
   enables nullifier replay or proof acceptance with mismatched
   public inputs. Tested by `tests/octora-mixer.ts` (positive path).

5. **Operator security.** The relayer's hot wallet, the multisig
   members' signing devices, and the ceremony coordinator's
   workstation are operator-side responsibilities. Compromising any
   one is in scope; compromising all multisig members in concert is
   considered out-of-scope (the protocol's social trust assumption).

## Known limitations / non-goals

- The mixer is a **fixed-denomination** privacy pool; small or
  unique amounts that don't match a tier are not in the anonymity
  set. See `docs/POOL_ROTATION.md` for the tier policy.
- Pause is a single switch covering both deposit and withdraw.
  Splitting these is a planned v0.2 upgrade; for now, pausing
  freezes user funds until unpaused.
- `ADMIN_AUTHORITY` is the only key that can call `set_paused`;
  losing the multisig permanently strands the pause control. The
  program upgrade authority (held separately) is the recovery
  vector for this scenario via a code-level admin rotation.

## Hall of Fame

(Populated as reports are received and resolved.)
