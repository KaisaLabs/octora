# Mode Fallback is auto-downgrade with post-hoc disclosure

When a Position in `fast-private` cannot complete the private path within its Funding TTL (e.g. Anonymity Set Guard never clears, mixer withdraw fails after pre-funding), the backend auto-downgrades the Position to `standard` and surfaces the downgrade *after the fact* via an Activity Record and a UI banner. The user is **not** gated on an ACK before the downgrade runs.

**Why:** Octora's target user is the degen LP trader (see project memory). A stuck trade is worse than a partially-private one — if we waited for an ACK and the user is AFK, the position aborts and the trade window closes. Speed-first is the product axis, privacy is a feature these users want but not at the cost of missing fills.

**Scope:** Policy is global, not per-Position. There is no Strategy Setup toggle to opt out. If a user wants the strict consent-before-downgrade behavior, they should pick `standard` up front.

**Note on naming:** The `downgradeRequiresDisclosure: true` field in `recoveryCatalog` reads like a pre-gate but means "surface a disclosure after the downgrade runs." Renaming to e.g. `surfaceDowngradeDisclosure` would clarify intent; tracked as glossary ambiguity in the backend `CONTEXT.md`.
