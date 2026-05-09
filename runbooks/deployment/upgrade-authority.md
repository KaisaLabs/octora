# Upgrade-authority transfer (P1-7)

**Status:** Authoritative procedure for moving BPF upgrade authority on both programs from the deploy keypair to a Squads multisig vault.
**Last updated:** 2026-05-10.
**Pre-requisite:** `MAINNET.md` steps 1–7 complete (programs deployed, IDLs uploaded). Squads vault provisioned per `MAINNET.md` §0.

## Why this matters

Anchor's default `solana program deploy` leaves the upgrade authority as a single key — usually the deploy payer. That key, if compromised, lets an attacker swap the program binary and drain every PDA the program controls (including the mixer pool). For Octora the audit treats single-key upgrade authority as a launch blocker.

The fix is a Squads v3 vault. For private beta we use a **2-of-3** policy; before opening to the public we tighten to **3-of-5**.

## Beta signer policy (2-of-3)

| Signer | Hardware | Recovery contact | Notes |
| --- | --- | --- | --- |
| Engineer A | Ledger Nano X | Engineer B | Online lead, signs daily ops |
| Engineer B | Ledger Nano X | Engineer A | Backup |
| Cofounder | Trezor Safe 3 | Engineer A | Cold — only co-signs upgrades / pause |

Record the three pubkeys in the deploy ticket and in `1Password / Octora / Mainnet / Squads`.

## 1. Provision the Squads vault

1. Go to https://app.squads.so and create a new "Multisig" with the three pubkeys above and a 2/3 threshold.
2. Copy the **Vault PDA** (NOT the multisig account itself — the vault PDA is the address the BPF Loader will see as upgrade authority).
3. Send a small amount of SOL (≥ 0.1) to the vault PDA so it can pay rent/fees on later admin txs.

The vault PDA is also the value that goes into:

- `programs/octora-mixer/src/constants.rs::ADMIN_AUTHORITY`
- `programs/octora-executor/src/constants.rs::EXECUTOR_ADMIN_AUTHORITY`

If the placeholder bytes are still on `main`, that's a stop-the-line — go back to `MAINNET.md` step 3.

## 2. Transfer upgrade authority

Run from a machine that holds the **current** deploy keypair (the one that signed the original `anchor deploy`). After this command runs, that key can no longer upgrade the program — the multisig is the only path.

```bash
# Sanity: confirm the current authority before changing anything.
solana program show <EXECUTOR_PROGRAM_ID>
solana program show <MIXER_PROGRAM_ID>
# "Authority:" must match the deploy keypair pubkey from `solana address`.

# Transfer.
solana program set-upgrade-authority <EXECUTOR_PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA>

solana program set-upgrade-authority <MIXER_PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA>
```

`solana program set-upgrade-authority` is irreversible without the new authority signing — type carefully.

## 3. Verify

```bash
solana program show <EXECUTOR_PROGRAM_ID> | grep Authority
solana program show <MIXER_PROGRAM_ID>   | grep Authority
# Both must show <SQUADS_VAULT_PDA>.
```

Cross-check inside the Squads UI: open the vault, confirm the two programs show up under "Programs / Upgrade Authority". Squads renders this from the on-chain account, so a mismatch here means the transfer didn't land.

## 4. Burn the deploy keypair

The deploy keypair from `MAINNET.md` step 2 has now done its job. Two acceptable disposal paths:

1. **Sealed offline.** Move the JSON to the offline backup vault (1Password → "Mainnet / Program Keys (BURNED)"), tag with the deploy date, and keep it for forensics. Never load it onto an online machine again.
2. **Destroyed.** If your threat model prefers no recoverable copy, `shred -u <keypair.json>` on a Linux machine and confirm the file is gone. Squads now controls upgrades; the original is dead weight.

Pick one and document the choice in the deploy ticket. Half-disposed keypairs are how every "single key compromise" post-mortem starts.

## 5. First multisig upgrade (drill)

Before any real upgrade lands on mainnet, walk through the flow on devnet so the signers know the UX cold:

1. Stage a no-op program upgrade on devnet (`anchor build`, then `anchor upgrade --program-id <DEVNET_ID> --provider.cluster devnet target/deploy/octora_executor.so` from a Squads-controlled keypair).
2. The first signer creates the upgrade transaction in Squads. The second co-signs.
3. Confirm the upgrade landed and the program version bumped.

Do this drill at least once per quarter. The day you actually need to ship a hot fix is the wrong day to learn the multisig UX.

## Public-launch tightening (3-of-5)

Before opening to the public:

- Add two more signers (a security advisor, a custodian).
- Bump threshold to 3/5 inside Squads (governance proposal — needs 2/3 from the existing signers).
- Re-publish the signer list so users can see who controls upgrades.

Document the transition date and the rationale alongside `runbooks/PRIVACY_MODEL.md` so the trust boundary is visible to anyone reviewing the project.

## When the multisig itself is unhealthy

If a Squads signer leaves the team or rotates a key:

1. Open a Squads "Replace Member" proposal. The remaining signers approve.
2. The proposal swaps the pubkey on-chain; no upgrade-authority change is needed because the authority is the **vault PDA**, not any individual member key.
3. Update this runbook's signer table.

If the vault PDA itself is compromised (improbable — it has no spending key), the only recovery is a fresh deploy under a new program ID and a coordinated migration. That scenario is covered in `runbooks/incident/program-bug-response.md` (TBD).
