# Pool Rotation Policy

This document describes how Octora handles the lifecycle of mixer pools:
when to deploy a new pool, when to retire an old one, and how the UI
routes between them. It exists because the on-chain Merkle tree has a
hard cap (`MAX_LEAVES = 2^20 ≈ 1.05M deposits`) — once that cap is
reached, the pool can never accept another deposit. Without a rotation
plan, hitting the cap bricks the protocol; with one, the cap is just a
scheduled rollover.

## Recommended model: tiered denominations + auto-rollover

We deploy multiple denominations from day one and auto-rollover each tier
to a new generation as it approaches capacity.

### Tiered denominations (day 1)

Five fixed-denomination pools, sized to span the realistic deposit
range while preserving meaningful anonymity sets per tier:

| Tier | Denomination | Use case |
|---|---|---|
| `0.1` | 100,000,000 lamports | Casual retail, micro-LP |
| `1`   | 1,000,000,000 | Default retail / small DeFi positions |
| `10`  | 10,000,000,000 | Mid-size LP positions |
| `100` | 100,000,000,000 | Whale tier |
| `1000`| 1,000,000,000,000 | Reserved (deploy when first 100-tier pool fills) |

Five tiers × 2^20 deposits = up to 5.2M deposits before the first
generation rollover, which gives meaningful runway. Each tier is its own
`MixerPool` PDA (`seeds = ["mixer_pool", denomination.to_le_bytes()]`),
so they evolve independently.

**Why fixed denominations rather than free-form deposits:** the anonymity
set for a withdrawal is "every deposit of the same denomination still in
the tree" — the smaller the denomination granularity, the smaller the
anonymity set. Tornado-style fixed tiers keep the anonymity set as large
as possible per dollar of TVL.

### Auto-rollover (per tier)

When a tier's `next_leaf_index` crosses **80% of `MAX_LEAVES`** (≈
838,000 deposits), the relayer/UI:

1. Stops accepting new deposits to the current generation pool.
2. Deploys a new pool at the same dollar denomination but with a new
   PDA-distinguishing salt (see "How to derive the next-generation PDA"
   below).
3. Routes new deposits to the new generation; routes withdrawals to the
   matching generation's pool based on the user's stored
   `(denomination, generation)` tuple in their commitment metadata.

The 80% threshold leaves a 20% buffer for stragglers — anyone who
generated a commitment against the old pool but hasn't deposited yet
still has tens of thousands of slots to land in.

The old generation pool stays open for **withdrawals only** indefinitely.
Anonymity-set-wise, the old pool is actually *more useful* as it ages —
no new deposits dilute it, but every withdrawal slowly drains it. We
never deactivate withdrawals on a fully-deposited generation; the
nullifier PDAs and the on-chain root history keep the proof system
working forever.

### How to derive the next-generation PDA

The current PDA is keyed on `denomination.to_le_bytes()` as 8 bytes. To
deploy a new generation at the same dollar denomination, we cannot reuse
those 8 bytes — the existing PDA is already there. Two options:

**Option A — bump the denomination by 1 lamport per generation.**
Generation 1 of the 1-SOL tier is `1_000_000_000`; generation 2 is
`1_000_000_001`; generation 3 is `1_000_000_002`. The on-chain program
needs no changes (the existing seeds work). The UI labels them all "1
SOL" since the difference is rounding noise.

This is the chosen approach because it requires zero on-chain changes.

**Option B — extend `MIXER_POOL_SEED` to include a generation byte.**
Cleaner long-term but requires an on-chain migration; we accept the
denomination-bumping hack for now and revisit only if we ever want to
clean up the seed schema.

### Off-chain registry

The relayer keeps a `pool_generations.json` file (or DB row) listing all
deployed pools by `(label, denomination_lamports, generation, status)`:

```json
[
  { "label": "0.1 SOL", "denomination": 100000000,    "generation": 1, "status": "active",     "deployedAt": "2026-06-01" },
  { "label": "1 SOL",   "denomination": 1000000000,   "generation": 1, "status": "draining",   "deployedAt": "2026-06-01", "filledAt": "2027-03-15" },
  { "label": "1 SOL",   "denomination": 1000000001,   "generation": 2, "status": "active",     "deployedAt": "2027-03-15" },
  { "label": "10 SOL",  "denomination": 10000000000,  "generation": 1, "status": "active",     "deployedAt": "2026-06-01" }
]
```

The browser fetches this list at page load and:

- Routes deposits to the `active` pool for the chosen tier.
- Routes withdrawals to whichever generation holds the user's
  commitment (the user's stealth-wallet metadata stores the
  `(denomination, generation)` they deposited into).

### Rollover decision criteria

`next_leaf_index >= 838,860` (80% of `MAX_LEAVES`) is the trigger for
proposing a rollover. The decision is made by the multisig that holds
`pool.authority` — they execute:

1. `set_paused(true)` on the old generation pool (stops new deposits;
    withdrawals continue per the program logic — let me verify this).

Wait — `is_paused` on the current program **also** blocks withdrawals
(see `withdraw.rs:99`). So we cannot use `set_paused` to drain a pool;
pausing locks user funds. The correct rollover sequence is:

1. **Do NOT pause the old pool.** Leave it fully operational.
2. Deploy generation 2 with the bumped denomination.
3. Update `pool_generations.json` to mark generation 1 as `draining`
   (UI hides it from the deposit picker but keeps it visible for
   withdrawals).
4. Once generation 1 reaches 100% capacity, the on-chain program itself
   will reject new deposits with `TreeFull` — no admin action needed.
5. Optional: hand the unused authority key off to a burn address once
   generation 1 is fully drained AND the multisig is comfortable that
   no further admin action will ever be needed for that pool. (Pause
   on a 100%-deposited pool that's draining via withdrawals only adds
   no value — there are no new deposits to halt.)

### Future change: drain-only pause flag

Worth a follow-up program upgrade: split `is_paused` into
`deposits_paused` and `withdrawals_paused` so admins can halt new
deposits without freezing existing user funds. Until that ships, the
"draining" state is purely a UI/registry convention; the on-chain pool
behaves identically until `next_leaf_index == MAX_LEAVES`.

## Alternatives considered

### Single-tier mixer (rejected)

A single 1-SOL pool would max out at ~1M deposits. Per-tier capacity is
fine, but you lose the ability to mix amounts other than 1 SOL — every
LP position smaller or larger has to be split or padded, which leaks
information. Tornado Cash settled on tiered denominations for the same
reason and we follow that precedent.

### Single tier with hard cap and forced retirement (rejected)

Stop accepting deposits at 80% capacity, force everyone to wait for the
next generation. Simplest on-chain logic but produces awkward "deposit
gaps" in the UI when one generation is 80% and the next isn't deployed
yet. Auto-rollover hides this from users.

### Variable denominations (rejected)

Let users deposit any amount. Maximum flexibility, minimum anonymity —
the anonymity set degenerates to "people who deposited the exact same
weird amount as you". Privacy-defeating.

## Open questions for the team

1. **Initial denomination set.** The 5-tier list above is a starting
   point. We may want to start with only 3 tiers (0.1 / 1 / 10) and
   deploy the larger tiers on demand to keep the audit surface small.
2. **Auto-deploy of generation 2.** Should generation 2 be deployed
   when generation 1 hits 80%, or pre-deployed at launch and held in
   "standby" so there's no admin action required at the rollover
   moment? Pre-deploying costs a small amount of rent per pool but
   means rollover is purely a `pool_generations.json` flip.
3. **Drain-vs-deposit pause.** When do we ship the
   `deposits_paused`/`withdrawals_paused` split? Treat as a v0.2
   priority once we've validated v0.1 in production.

## Action items (pre-mainnet)

- [ ] Decide initial tier set (recommend: 0.1, 1, 10).
- [ ] Decide pre-deploy vs lazy-deploy for generation 2 of each tier.
- [ ] Add `pool_generations.json` schema to the relayer config.
- [ ] Write the UI logic that picks `(denomination, generation)` for
      each deposit/withdrawal action.
- [ ] Track `next_leaf_index` per pool with an alert at 70% so the
      multisig has time to coordinate the rollover before 80%.
