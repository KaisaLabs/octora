# Octora: PM/BD One-Pager

## Short Summary

Octora is a privacy execution layer for Meteora LP actions on Solana. The product goal is simple: help active LP users add liquidity, claim, and exit without making their main wallet trivially linkable to their position activity.

This brief is for PM/BD collaborators who want to sharpen research, support deck creation, and help frame Octora as both a credible hackathon story and a real startup wedge.

## What Octora Is

Octora is a standalone product for private-feeling LP execution on Meteora.

It is not trying to sell users on privacy infrastructure. It should feel like a clean, focused tool that helps them LP faster and with less copy-following risk. Under the hood, the product creates distance between a user's main wallet and the wallet or execution identity that touches the LP position.

## Problem / Why This Matters

The pain is real and specific. Real LP users already rotate wallets manually 5 to 6 times a day to avoid getting copied. That is operationally annoying, mentally taxing, and easy to get wrong.

Today, if a trader LPs from their main wallet, adds, claims, and exits on Meteora, that trail is visible and easy to monitor. In a fast, onchain environment, that means other traders can follow, react to, or free-ride on behavior that took real skill to develop.

Octora matters if it can make that copy-following meaningfully harder without slowing users down so much that they stop using it.

## Who It Is For

- Active Solana LP users on Meteora
- Higher-conviction or more alpha-sensitive LP traders who do not want their main wallet patterns exposed
- Users who care about speed and simplicity more than maximal privacy theory
- Early adopters who currently use manual wallet rotation as a workaround

## Why Now

- Copy-trading and wallet-following behavior on Solana is already real, visible, and productized.
- LP users are already inventing manual privacy workflows, which is a strong signal that the problem is not hypothetical.
- Solana users expect fast, low-friction products; if privacy can be packaged without heavy UX tax, adoption can be much stronger.
- Meteora gives Octora a narrow first venue with clear user actions and a recognizable user base.

## Why Solana / Why Meteora

Solana is where fast, highly observable onchain behavior meets a user base that actually cares about execution edge.

Meteora is a strong first venue because LP actions are concrete and frequent: add liquidity, claim, withdraw, close. That makes the problem easy to explain and the MVP easier to scope. Instead of trying to be a generic privacy product for all of crypto, Octora starts with a focused execution use case where the user pain is already visible.

## Product Wedge / Differentiation

- Clear wedge: privacy execution for Meteora LP actions, not general-purpose privacy infra
- User-centric framing: protects trading behavior without asking users to learn privacy concepts
- Practical promise: make main-wallet-to-position linkage materially harder, not magically invisible
- Speed-sensitive design: built for degen LP behavior, where latency and extra steps matter
- Strong narrative fit: simple enough for hackathon judging, sharp enough for startup thesis expansion

## MVP Shape

MVP is a narrow, standalone product with a SOL-first happy path.

Supported actions:

- Add liquidity
- Claim
- Withdraw / close

High-level experience:

- User connects a normal wallet
- User chooses a Meteora LP action
- Octora handles the privacy-preserving execution path in the background
- User sees a simple product workflow, not privacy plumbing

The first version is about proving that users want a smoother alternative to manual wallet rotation.

## What We Are Not Claiming Yet

- We are not claiming perfect anonymity.
- We are not claiming fully invisible onchain behavior.
- We are not claiming generalized privacy across all Solana trading.
- We are not claiming a fully built product stack today.
- We are not claiming shielded rails or a PER-native runtime in MVP.

Today, the workspace is still waitlist-first; the product stack has not been built yet.

Approach 2 (shielded rails first) and Approach 3 (PER-native runtime) are future paths, not part of the initial MVP claim.

## Key Research Questions for PM/BD

- How painful is manual wallet rotation in real day-to-day LP workflows?
- What level of privacy improvement would feel meaningfully useful to target users?
- Which user segments feel this pain most acutely: retail power users, semi-pro LPs, teams, or KOL-style public wallets?
- What failure modes would make users stop trusting or reusing a product like this?
- How much speed or convenience tax will users tolerate for better unlinkability?
- Which messaging lands better: privacy, anti-copying, execution protection, or wallet hygiene?
- What proof points would make users believe this is safer than doing it manually?

## Competitor / Substitute Watchlist Categories

- Manual wallet rotation workflows
- Wallet-following and copy-trading products
- Solana wallet analytics and alerting tools
- General privacy products or privacy rails on Solana
- LP automation or execution tooling around Meteora
- Offchain coordination habits users employ to avoid signaling positions

## What Evidence Would Strengthen the Pitch Deck

- Interview notes or quotes from real LP users describing the pain in their own words
- Clear examples of users rotating wallets multiple times per day
- Evidence that wallet-following behavior changes execution outcomes or user behavior
- A crisp before/after workflow showing manual rotation versus Octora
- Early waitlist or user interest from the right LP cohort, not just broad crypto curiosity
- Any signal that users would reuse the product for recurring LP management, not just one-off testing

## Risks / Things to Validate Early

- Users may want stronger privacy than MVP can realistically offer.
- Users may reject any noticeable speed or UX penalty.
- The story could drift into "privacy infra" and lose the simple product wedge.
- The market may agree the pain is real but still not trust a third-party execution layer enough to use it.
- The first wedge may be too narrow unless it clearly expands into a broader execution thesis later.

## Suggested Story Angles for a Future Pitch Deck

- "LP users are already doing this manually; Octora makes it usable."
- "The problem is not privacy ideology, it is execution protection."
- "Octora starts with Meteora because narrow products win trust faster than broad infra claims."
- "Make copy-following materially harder without breaking degen speed."
- "Hackathon entry today, execution-layer company thesis tomorrow."

## Immediate Asks from PM/BD Collaborators

- Talk to real Meteora LP users and pressure-test how often they rotate wallets and why.
- Gather direct quotes that explain the pain, urgency, and current workaround behavior.
- Map the substitute landscape, especially wallet-following tools and manual workflows.
- Help refine the best narrative frame: privacy, execution protection, anti-copying, or alpha defense.
- Collect deck-grade evidence: user anecdotes, workflow comparisons, and early interest signals.
- Stress-test whether the wedge feels sharp enough for a hackathon story and large enough for a startup thesis.
