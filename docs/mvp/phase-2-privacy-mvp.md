# Phase 2 — Privacy MVP

**Goal:** A user deposits into the Octora mixer, receives a stealth wallet, opens an LP position from that stealth wallet, and can later withdraw to a fresh recipient — without linking origin and LP wallets on-chain.

**Why this phase second:** This is the differentiator. But it only matters once Phase 1 proves the LP plumbing works. Otherwise we're shipping privacy on top of a broken core.

**Prerequisite:** Phase 1 ship gate is met.

**Target duration:** 2–3 weeks.

---

## 1. Production relayer

- [ ] Stand up a real relayer service (replacing `MockPrivacyAdapter` and the throwing `RelayerAdapter`)
- [ ] Relayer accepts ZK proof + public inputs, submits withdraw tx, takes its fee from the deposit denomination
- [ ] Rate limiting + abuse protection (one relay per nullifier, signed requests)
- [ ] Relayer monitoring: success rate, latency, balance alerts
- [ ] Failure modes: stuck tx, low balance, nullifier already spent — each maps to a clear user-facing message
- [ ] At least 2 relayer instances for redundancy; client picks one or rotates

## 2. Mixer → stealth wallet flow integrated into Add Liquidity

- [ ] Privacy-mode toggle in the Add Liquidity confirm modal (Direct / Private)
- [ ] When Private is selected:
  - [ ] Show denomination options matching mixer pools
  - [ ] Show current anonymity-set size for chosen denomination (red < 50, yellow 50–200, green > 200)
  - [ ] Generate stealth wallet client-side, persist seed in encrypted local storage
  - [ ] Deposit to mixer from connected (origin) wallet
  - [ ] Wait for confirmations, then withdraw via relayer to stealth wallet
  - [ ] Stealth wallet is now funded — proceed with normal Add Liquidity flow from Phase 1
- [ ] Backend state machine handles privacy-mode positions through the existing 11 states; mixer steps slot into `funding_in_progress`

## 3. Stealth wallet management UI

- [ ] "Stealth wallets" section in the wallet picker
- [ ] List each stealth wallet: balance, linked positions, created date
- [ ] Recovery flow: import seed phrase or backup file → restore stealth wallet + its positions
- [ ] Backup prompt the first time a user creates a stealth wallet (download encrypted JSON or copy seed)
- [ ] Clear warning about local-storage-only persistence and what loss means
- [ ] Withdraw-to-origin: one-click flow that closes a position from a stealth wallet and routes funds back via the mixer to a fresh recipient

## 4. Privacy explainer + trust UX

- [ ] First-run modal the first time a user picks Private mode: what's anonymous, what isn't, why anonymity-set size matters, what fees apply
- [ ] Inline tooltips on every step (deposit, withdraw, stealth wallet, anonymity set)
- [ ] `/learn/privacy` page with longer explanation, threat model, known limitations
- [ ] Disclaimer + risk warning checkbox on first private deposit
- [ ] Link to mixer source code + audit status (or "unaudited" badge if applicable)

## 5. Hardening

- [ ] Audit the mixer program (external review, even if informal)
- [ ] Audit the relayer service (key management, request signing, replay protection)
- [ ] Per-denomination deposit / withdraw test on mainnet with real funds at small size
- [ ] Anonymity-set monitoring dashboard (internal): deposits in / withdrawals out per denomination per day
- [ ] Documented incident response for: relayer compromise, mixer pause, stuck nullifiers

---

## Ship gate for Phase 2

- [ ] A user can complete a full private LP cycle on mainnet: deposit to mixer → stealth wallet funded → open LP → claim fees → close → withdraw to a fresh wallet
- [ ] Origin wallet and LP wallet are not linked in any on-chain trace (verified manually with a block explorer)
- [ ] Anonymity-set size is shown and accurate at deposit time
- [ ] Stealth wallet recovery works from a clean browser given only the seed
- [ ] Relayer has > 99% success rate on a 7-day window
- [ ] At least one external user completes the private flow on mainnet
- [ ] Privacy explainer reviewed by someone outside the team for clarity
