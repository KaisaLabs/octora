# Manual setup overview

Everything in this folder is operator work, not code work. The engineering plan is `MVP_LAUNCH_PLAN.md` at the repo root. This index sequences the manual steps so the long-lead-time items kick off on Day 1.

## Files

| # | Doc | Purpose | Lead time | Day to start |
| --- | --- | --- | --- | --- |
| 01 | `01_SQUADS_MULTISIG.md` | Set up the Squads vault that holds upgrade authority for both programs | 1–2 days for keygen + signer testing | Day 1 |
| 02 | `02_TRUSTED_SETUP_CEREMONY.md` | Phase 2 Groth16 ceremony with ≥3 contributors | 1–3 days execution + scheduling | Day 1 (book contributors) → Day 11 (run) |
| 03 | `03_RELAYER_KMS.md` | Move relayer signing keys off the API host into AWS KMS | 1 day provisioning | Day 2 |
| 04 | `04_RPC_PROCUREMENT.md` | Sign contract for dedicated mainnet RPC | 1–2 weeks procurement | Day 1 (RFP) |
| 05 | `05_LEGAL_TOS_BETA.md` | Lawyer-reviewed ToS, Privacy Policy, Risk Disclosure, beta cohort agreement | 2 weeks | Day 1 (engage) |
| 06 | `06_MONITORING_ALERTING.md` | Sentry, UptimeRobot, PagerDuty, dashboards, status page | 1 day | Day 7 |
| 07 | `07_SECRETS_MANAGEMENT.md` | Doppler / 1Password / AWS SM sync, rotation, log retention | 1 day | Day 4 |
| 08 | `08_MAINNET_DEPLOY_DAY.md` | The go-live runbook executed on Day 14 | 1 day | Day 13 (rehearse) → Day 14 (execute) |

## Dependency graph

```
[lawyer engagement] ──────────────────────────────────────▶ [ToS live]
                                                                │
[RPC procurement] ─────────▶ [staging RPC] ─▶ [mainnet RPC]    │
                                                  │             │
[Squads keygen] ─▶ [Squads vault PDA] ─▶ [ADMIN_AUTHORITY in code]
                                                  │             │
[KMS provisioning] ─▶ [KMS keys funded] ─▶ [relayer points at KMS]
                                                  │             │
[Ceremony scheduling] ──────────▶ [ceremony Day 11] ─▶ [VK rebuilt]
                                                  │             │
                                                  ▼             ▼
                                              [Day 13 dress rehearsal]
                                                  │
                                                  ▼
                                              [Day 14 mainnet deploy]
                                                  │
                                                  ▼
                                              [Day 15 beta open]
```

## Cost rough estimate (3 weeks + first month of beta)

| Item | One-time | Recurring monthly |
| --- | --- | --- |
| Lawyer ToS / Privacy / Risk Disclosure | $3 000 – $8 000 | — |
| Lawyer ongoing retainer (Q&A) | — | $500 – $1 500 |
| Helius Premium / Triton / QuickNode RPC | — | $500 – $2 000 |
| AWS KMS keys (2 keys × $1/mo + sign requests) | — | $20 – $50 |
| Sentry team plan | — | $26 – $80 |
| PagerDuty professional | — | $21 per user |
| Better Uptime / UptimeRobot | — | $0 – $30 |
| Doppler team | — | $0 – $15 per user |
| Squads vault gas (one-time setup) | $5 | — |
| External audit (engaged Day 1, lands post-beta) | $40 000 – $120 000 | — |
| Hosting (compose VM + Postgres-managed-or-self) | — | $50 – $300 |

**Beta-period budget** (excluding audit): roughly $5 000 – $12 000 one-time + $700 – $4 000/mo.

**Audit** is by far the biggest line item. Procurement starts Day 1 because the audit itself takes 6–14 weeks; the contract signing and engagement can happen now and run in parallel with beta.

## Who owns what

| Role | Responsibilities |
| --- | --- |
| **Operator (you)** | All items in this folder. Drives lawyer, RPC procurement, ceremony coordination, Squads signer coordination, beta tester onboarding, deploy day, war room. |
| **Engineer A** (programs + relayer) | Code work in `programs/` and the relayer / KMS adapter. Standby on deploy day. |
| **Engineer B** (API + frontend) | Code work in `octora-api/` and `octora-web/`. Standby on deploy day. |
| **Squads signers** (≥3 people) | Hold signer keys, sign upgrade authority changes and emergency pauses. Tested on devnet Day 5 and Day 13. |
| **Ceremony contributors** (≥3 people) | Run trusted-setup contributions on Day 11. Different people from Squads signers (defense in depth). |

## What to do first today

1. Read `01_SQUADS_MULTISIG.md` and start signer key generation (you + 2 trusted people, Ledger hardware wallets recommended).
2. Read `05_LEGAL_TOS_BETA.md` and email a lawyer with the brief.
3. Read `04_RPC_PROCUREMENT.md` and request quotes from Helius, Triton, QuickNode.
4. Read `02_TRUSTED_SETUP_CEREMONY.md` and message ≥3 trusted technical contributors to book a Day 11 slot.
5. Read `03_RELAYER_KMS.md` and decide AWS KMS vs separate signing VM. (Recommend AWS KMS.)

Steps 1–4 are independent and can run in parallel.
