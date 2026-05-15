# Incident: on-chain program bug response (P1-45)

**Status:** Authoritative procedure for responding to a confirmed bug in `octora-mixer` or `octora-executor`.
**Last updated:** 2026-05-10.
**Severity:** P0 — coordination across engineering, signers, and operations.

## Trigger

Use this runbook when:

- A confirmed exploit drains funds from the mixer pool or any stealth wallet.
- An auditor or external researcher reports a vulnerability with proof of concept.
- A unit / integration test caught a logic bug AFTER the program shipped.
- A program upgrade attempt itself failed mid-flight.

If the trigger is "we got an unsolicited tip with no PoC," start with `mixer-pause.md` instead — pause first, validate the claim, and only escalate here if the bug reproduces.

## 0. The pause-first principle

**Always pause before doing anything else.** Even if the bug is upgrade-recoverable, pausing first:

- Stops further fund movement while you debug.
- Prevents the attacker from front-running your upgrade.
- Buys time to coordinate Squads signers without time pressure.

Run `runbooks/incident/mixer-pause.md` §1–§3 BEFORE proceeding here. The rest of this document assumes the program is paused.

## 1. Establish the war room

- Open `#inc-octora-program-YYYYMMDD-<slug>` in Slack.
- Page: on-call eng, the two co-founders, and (if it's a confirmed exploit) outside counsel.
- Open the Squads UI tab and confirm at least 2-of-3 signers are online and reachable.
- Designate one **incident commander** — typically the senior eng on call. Everyone else takes direction from them.

## 2. Reproduce on devnet before touching mainnet

A program upgrade is a one-way operation per slot — a botched fix is worse than no fix. Always reproduce on devnet first.

```bash
# Branch from main; do NOT cherry-pick into a release branch yet.
git checkout -b fix/program-bug-<slug> main

# Reproduce in a test:
pnpm --filter octora-api test tests/octora-<area>.ts
# Or via a one-shot LiteSVM repro in tests/.
```

Add a regression test that captures the exact failure mode. The test landing alongside the fix is the evidence that the patch addresses the reported bug.

## 3. Land the fix

Land the patch on `fix/program-bug-<slug>` with:

- The regression test (red without the fix, green with).
- A code-only PR description that pins the audit finding: "Fixes <P-tag from `runbooks/PRODUCTION_READINESS.md` or external advisory>."
- Any Cargo bumps + `Cargo.lock` updates the fix touches.

Get a second engineer's review. Two-person sign-off on a P0 fix is non-negotiable.

## 4. Build + deploy candidate

From the deploy host:

```bash
git checkout fix/program-bug-<slug>
anchor build --no-idl
sha256sum target/deploy/octora_executor.so target/deploy/octora_mixer.so
git log -1 --format=oneline
```

Pin the new SHAs in the incident channel. Compare to the SHAs of the currently-deployed binary (`solana program show <ID>` returns the program-data length and slot — that's your match against the source SHA via `solana-verify` if it's wired).

## 5. Squads-coordinated upgrade

The BPF upgrade authority is the Squads vault PDA (P1-7). The upgrade is a normal tx the multisig signs:

```bash
# Build the upgrade instruction.
solana program write-buffer target/deploy/octora_<program>.so \
  --keypair <DEPLOY_PAYER>
# Output: a Buffer pubkey, e.g. Buf...

# Construct the upgrade ix:
solana program upgrade <BUFFER_PUBKEY> <PROGRAM_ID> \
  --upgrade-authority <SQUADS_VAULT_PDA>
# This emits an unsigned tx. Pipe into Squads.
```

In Squads:

1. Signer A creates the upgrade proposal.
2. Signer B approves.
3. Execute.

Wait for `Finalized` on the upgrade signature.

## 6. Verify

```bash
solana program show <PROGRAM_ID>
# - "Last deployed slot" should be the upgrade slot, not the original deploy slot.
# - "Data length" should match the new .so size.
```

Run a smoke test:

- For mixer: a deposit + (post-delay) withdraw on a small denomination.
- For executor: an `init_position` + `add_liquidity` + `withdraw_close` on a low-stakes pool.

Both must run cleanly before unpausing.

## 7. Unpause

Per `mixer-pause.md` §6. Squads-signed `set_paused(false)` for both programs (or just the one that was patched, if scoped).

Confirm `/metrics` shows `mixer.isPaused = false` and `/health` is GREEN.

## 8. Public communication

Post within 1 hour of resuming:

- A short summary of the bug class (e.g. "missing `Signer` constraint on a DAMM admin instruction").
- The mitigation (paused + upgraded; no funds lost OR <X SOL of impact, refunded).
- A timeline.
- A link to the post-mortem ETA.

Do NOT include the exploit's reproduction steps until at least 7 days of monitoring have passed. The mainnet bytecode is now patched, but copycats can still hit unrelated programs that share the same pattern.

## 9. Post-mortem

Within 7 days:

- Full timeline (detection → pause → fix → upgrade → resume).
- Root cause, including which previous review or audit step missed it.
- Why the recovery worker / monitoring caught it (or didn't).
- Process changes — e.g., a new `clippy` lint, a new test coverage requirement, a new pre-deploy review step.
- Compensation plan for impacted users, if any.

## 10. Auditor notification

If an external auditor (Zellic / OtterSec / Trail of Bits) is engaged on a future audit, send them this post-mortem and ask whether the fix changes any audit assumptions. Audit firms appreciate this — it usually shortens future engagements.

## When the upgrade itself fails

If `solana program upgrade` returns an error, the buffer state is the recovery path:

- The buffer (`Buf...` pubkey) holds the new bytecode but isn't installed.
- Re-run the upgrade tx, signed by the multisig. The buffer is fungible across attempts as long as it isn't closed.
- If the upgrade keeps failing AND mainnet stays paused, this is the moment to consider a fresh-deploy migration (new program IDs, user migration, painful — see `runbooks/PRODUCTION_READINESS.md` §10 for what's out of scope to attempt at this stage).

## What this runbook deliberately does NOT cover

- Post-quantum migration. Out of scope for the beta — covered if/when the project ships a v2 cryptographic regime.
- Attacker-controlled multisig. If the Squads vault itself is compromised, this runbook can't help. That's a `runbooks/incident/multisig-compromise.md` (TBD) and the practical answer is a fresh program deploy.
