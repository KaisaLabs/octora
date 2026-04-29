---
project: Octora
workspace_type: monorepo-like
root: /Users/xfajarr/JarProjects/octora
security_score: B-
quality_score: C+
ready_for_mainnet: false
overall_assessment: "Functionally impressive for a fresh workspace, but not production-ready yet. The main gaps are unsafe fallback behavior, non-durable indexing recovery, and a route contract that advertises unsupported draft actions."
review_scope:
  - apps/octora-web/src/lib/api.ts
  - packages/indexer/src/position-indexer.ts
  - services/orchestrator-api/src/routes/position-routes.ts
findings:
  - id: octora-web-mock-fallback
    severity: high
    category: product_correctness
    file: apps/octora-web/src/lib/api.ts
    issue: "Request failures fall back to fabricated mock success results, which can make an outage or misconfiguration look like a successful position lifecycle."
    impact: "Users can be shown false success states and the app can mask real API failures."
    fix: "Remove the fallback entirely, or gate it behind an explicit DEV/demo flag. On failure, return a surfaced error state and keep the UI honest. If a demo path is required, make it opt-in and impossible in production builds."
  - id: indexer-memory-reconciliation
    severity: medium_high
    category: reliability
    file: packages/indexer/src/position-indexer.ts
    issue: "Reconciliation state is only kept in memory, so a process restart can lose the snapshot and leave a position stuck in indexing without a durable recovery path."
    impact: "Indexes may stall after restarts and require manual intervention."
    fix: "Persist reconciliation metadata or signatures in Prisma, then reconstruct the pending state on boot so in-flight positions can resume after restarts."
  - id: orchestrator-unsupported-drafts
    severity: medium
    category: api_contract
    file: services/orchestrator-api/src/routes/position-routes.ts
    issue: "Draft creation accepts claim and withdraw-close actions even though the orchestrator only truly supports the add-liquidity draft/execute path."
    impact: "Clients get an API contract that implies workflows the backend cannot reliably execute."
    fix: "Reject unsupported draft actions until they are implemented, or add separate explicit draft flows with matching execution logic and tests."
notes:
  - "Do not add extra findings unless they are verified in code."
  - "This review should be treated as a snapshot, not a release sign-off."
---

# Octora Code Review Context

The workspace is a new monorepo-like setup with `apps/octora-web`, `services/orchestrator-api`, and `packages/*`.

## Summary

Octora is promising and already has meaningful product surface area, but the current implementation is not ready for mainnet or production traffic.

## Findings

1. `apps/octora-web/src/lib/api.ts`
   - High severity, product correctness
   - The API client silently fabricates success on request failure.
   - Fix: remove the fallback or make it explicit DEV/demo-only, and surface real errors in the UI.

2. `packages/indexer/src/position-indexer.ts`
   - Medium-high severity, reliability
   - Reconciliation state lives only in memory and is lost on restart.
   - Fix: persist reconciliation metadata/signatures in Prisma and restore pending work on boot.

3. `services/orchestrator-api/src/routes/position-routes.ts`
   - Medium severity, API contract
   - `claim` and `withdraw-close` drafts are accepted even though only add-liquidity is truly supported.
   - Fix: reject unsupported draft actions or implement their flows explicitly.

## Scores

- Security: `B-`
- Quality: `C+`
- Ready for mainnet: `false`

## Overall Assessment

The codebase is functional and well on its way, but the current behavior can mislead users, lose indexing progress on restart, and expose an API surface that overpromises supported actions.
