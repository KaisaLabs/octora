# Legal, ToS, and beta cohort agreement

**Why this matters:** privacy mixers attract regulatory attention (Tornado Cash precedent). Beta testers must sign an acknowledgement of risk and a non-recourse agreement. Without a documented legal posture, you have personal exposure.

**Closes:** P1-51 (ToS / Privacy / Risk Disclosure), P1-52 (beta cohort agreement), partial P2-33 (sanctions screening — replaced for beta with geographic restriction).

**This is the longest-lead-time item — engage a lawyer Day 1.**

## Lawyer brief (send Day 1)

Subject: **Solana privacy product launch — ToS / Privacy / Risk review needed in 2 weeks**

Body:

> Hi [lawyer],
>
> We're launching closed beta of a Solana DeFi privacy product (Octora) in 3 weeks. We need lawyer-reviewed:
>
> 1. **Terms of Service** — non-custodial framing, no warranty, dispute resolution, jurisdiction (suggest Cayman / Singapore / BVI), governing law, AML acknowledgements.
>
> 2. **Privacy Policy** — what we collect (wallet addresses, IPs, Sentry telemetry), what we don't (no KYC), retention (relayer logs < 24 h), data subject rights, third-party processors (Sentry, Helius, etc.).
>
> 3. **Risk Disclosure** — smart-contract risk (unaudited at beta open, audit in flight), Groth16 trusted-setup risk, relayer compromise risk, regulatory risk (mixer-style products), economic risk (LP impermanent loss), key-loss risk (stealth wallet recovery model), no-recourse acknowledgement.
>
> 4. **Beta cohort agreement** — per-tester signed letter: acknowledged risk, max deposit cap (mirrored server-side), no recourse, confidentiality if applicable, bug-reporting channel.
>
> 5. **Geographic restriction policy** — block US, OFAC-listed, and other sanctioned jurisdictions via ToS clause + Cloudflare country block. Documented opinion on whether this posture is sufficient given Tornado precedent (we are NOT planning OFAC screening at deposit-side for beta — option to add later if your opinion requires).
>
> 6. **Entity structure recommendation** — should the beta operate under a personal name, an existing entity, or a new entity (Cayman foundation? Swiss association?)? We can decide quickly if you can flag the headline tradeoff.
>
> Target: drafts by end of Week 2 (10 business days). Final + signed by Day 13. We're targeting beta open Day 15.
>
> Existing material we can hand over:
> - `runbooks/PRIVACY_MODEL.md` (the threat model)
> - `runbooks/ARCHITECTURE.md`
> - `runbooks/PRODUCTION_READINESS.md` (audit findings — useful for risk disclosure language)
>
> What we have today as a placeholder ToS modal: `octora-web/src/lib/tosAck.ts` (signed message format already in place; you fill the actual text).
>
> Budget: $3 000 – $8 000 for one-time review + retainer for ongoing Q&A. Let us know.

Find a lawyer who has done crypto/DeFi work before. Avoid generic startup lawyers — the regulatory landscape for mixers is specific, and someone unfamiliar will give either over-cautious "don't do it" advice or under-cautious "looks fine" advice.

Recommended firms (DYOR — these change): Latham & Watkins (crypto group), Cooley LLP (crypto group), Anderson Kill, MetaLeX. Boutique alternatives: K&L Gates, Anderson Mōri & Tomotsune (if Japan-friendly), Conyers (Cayman).

## Geographic restriction (beta posture)

For MVP we are **not** running on-chain sanctions screening. Instead:

1. **ToS clause:** "you represent that you are not located in, organized in, or a resident of the United States, OFAC-sanctioned jurisdictions, or [other prohibited list]."
2. **Cloudflare country block:** in front of `octora-web` and `octora-api`, block requests from `country IN (US, IR, KP, SY, CU, RU, BY)` and any other lawyer-recommended list. Returns a 451 Unavailable For Legal Reasons with a brief explanation.
3. **Wallet self-attestation:** the ToS modal includes a checkbox "I am not located in or a resident of [list]." Click is logged with timestamp + signed by wallet (server-side per P2-NEW-D).

This is **not equivalent** to OFAC screening (a sophisticated user can VPN around country blocks). It is, however, a documented good-faith effort. The lawyer's opinion (point 5 above) is what tells you whether this is sufficient or whether you need to add Chainalysis/TRM at deposit-side before beta.

Put real OFAC screening on the roadmap (P2-33 in the audit doc) for before public launch.

## Required documents at beta open

| Document | Source | Lives at | Server-side ack |
| --- | --- | --- | --- |
| Terms of Service | Lawyer | `/legal/tos` (versioned) | Yes (P2-NEW-D table) |
| Privacy Policy | Lawyer | `/legal/privacy` | Implicit ack via ToS |
| Risk Disclosure | Lawyer | `/legal/risk` | Yes (signed message includes "I have read the risk disclosure") |
| Beta cohort agreement | Lawyer | DocuSign or signed PDF | Operator-managed; copy in `runbooks/legal/cohort/<wallet>.pdf` |
| Geographic restriction | ToS clause | Inside ToS | Wallet checkbox + server log |

Versioned: `CURRENT_TOS_VERSION = "v1-2026-MM-DD"` in `octora-web/src/lib/tosAck.ts`. Bumping the version forces re-acknowledgement on next session.

## Beta cohort agreement template

Lawyer will produce the canonical version. Skeleton to give them as input:

> **Octora Beta Tester Agreement (v1)**
>
> Between: [Octora entity], "Provider"
> And: [tester legal name], "Beta Tester", with Solana wallet address `<pubkey>`.
>
> 1. **Beta nature.** Provider is operating Octora in closed beta on Solana mainnet. The software, smart contracts, and infrastructure are subject to bugs, downtime, and changes without notice.
>
> 2. **Risk acknowledgement.** Beta Tester acknowledges they have read the Risk Disclosure at `/legal/risk` and understands: smart-contract risk, ZK trusted-setup risk, relayer compromise risk, regulatory risk, economic risk, and key-loss risk.
>
> 3. **Cap.** During beta, Beta Tester will deposit no more than [2.5 SOL per position] and no more than [10 SOL total] across all open positions. Provider enforces this cap server-side; Beta Tester agrees not to circumvent.
>
> 4. **Non-recourse.** Beta Tester accepts that any loss of funds during beta is at Beta Tester's own risk. Provider has no obligation to refund or compensate.
>
> 5. **Confidentiality.** Beta Tester agrees not to disclose findings, screenshots, or details of the beta product publicly without Provider's consent until [public launch date]. Vulnerability reports are exempted (see clause 7).
>
> 6. **Geographic eligibility.** Beta Tester represents they are not located in, organized in, or a resident of [restricted list].
>
> 7. **Vulnerability reporting.** Beta Tester agrees to report any discovered security issue to `security@octora.<domain>` and not publicly disclose for [90 days] from initial report. Provider will respond within [3 business days].
>
> 8. **Termination.** Either party may terminate with [7 days] notice. On termination, Beta Tester will close all positions and withdraw funds; Provider will revoke access to the beta software.
>
> 9. **Governing law.** [Jurisdiction TBD by lawyer].
>
> Signed: ___________ (Beta Tester)
> Signed: ___________ (Provider — operator)
> Date: ___________

Adjust the bracketed values once you've finalized your TVL caps and operating entity.

## Beta tester onboarding flow

1. Send the beta agreement PDF (DocuSign or similar).
2. Tester signs and returns.
3. Operator countersigns.
4. Operator runs `POST /admin/waitlist/approve` with the tester's wallet address (gates `BetaAccess` table).
5. Operator emails tester with: beta URL, ToS link, support channel (Discord/email), known issues, contact for security issues.
6. First time tester connects wallet → presented with ToS modal → must sign (server-side ack via P2-NEW-D).
7. Tester proceeds to deposit.

## Server-side ack table (engineer B work, Day 4)

```
model TosAcknowledgement {
  id              String   @id @default(cuid())
  walletAddress   String
  version         String
  signature       String
  acknowledgedAt  DateTime @default(now())

  @@unique([walletAddress, version])
  @@index([walletAddress])
}
```

`POST /auth/ack-tos` accepts `{ walletAddress, version, signature }`, verifies signature is over `"Octora ToS v<version> ack"` by `walletAddress`, inserts row.

`requireBetaAccess` preHandler in `position.routes.ts` and `mixer.routes.ts` adds a check: `TosAcknowledgement` row exists for `walletAddress + CURRENT_TOS_VERSION`. If not, return 412 with `{ error: "TOS_ACK_REQUIRED", version: CURRENT_TOS_VERSION }`. Frontend handles by re-showing the modal.

## Privacy Policy specifics

Lawyer will draft, but they need to know what you actually do:

- **Collected**: wallet addresses (gating + activity), IP addresses (rate limiting + geographic filter), Sentry telemetry (errors + breadcrumbs, wallet hashed), beta tester legal name (cohort agreement), email (waitlist sign-ups).
- **Not collected**: KYC documents, government IDs, real names other than for beta cohort agreement, transaction amounts beyond what's already public on-chain.
- **Retention**:
  - Relayer logs: < 24 h (P1-17a)
  - Sentry: 90 days
  - Beta agreements: indefinitely (legal hold)
  - Waitlist emails: until removal request
- **Third parties**: Sentry, Helius / chosen RPC, Cloudflare, AWS (KMS / Secrets Manager), Doppler, PagerDuty.
- **Data subject rights**: deletion of email from waitlist on request; cannot delete on-chain data (immutable); can delete server-side activity logs on request post-position-close.

## What you cannot avoid

- Lawyer engagement. Don't ship without one. The cost is small relative to the personal liability if something goes wrong.
- Ack server-side. LocalStorage-only ack means the user can wipe their browser and you have no proof they ever agreed.
- Geographic restriction. At minimum the ToS clause; ideally the Cloudflare block too.

## Reference

- Existing `octora-web/src/lib/tosAck.ts` — current placeholder ack.
- Existing `octora-api/prisma/schema.prisma` — for the `TosAcknowledgement` model addition.
- Tornado Cash sanctions designation (Aug 2022) — context for why this matters.
