# Squads multisig setup

**Why this matters:** the upgrade authority for `octora-mixer` and `octora-executor` is the master key of the system. If a single attacker compromises that key, they can deploy malicious bytecode and drain every mixer pool. A multisig means an attacker needs ≥ M-of-N independent signers to do that.

**Closes:** P0-1 (replace `ADMIN_AUTHORITY` placeholder), P1-7 (transfer upgrade authority).

**Tool:** Squads v3 — the standard Solana program multisig.

## Configuration for beta

| Setting | Value | Reason |
| --- | --- | --- |
| Threshold | 2-of-3 | Two-person rule — single key compromise is not catastrophic, low coordination overhead |
| Signers | You + 2 trusted technical co-founders / advisors | Different physical locations and different hardware vendors recommended |
| Hardware | Ledger Nano X (or Trezor) for each signer | No software-only signers |
| Vault label | `octora-mainnet-v1` | Versioned so a future M-of-N change creates a new vault |

Bump to 3-of-5 before public launch.

## Step-by-step

### 1. Each signer generates a keypair on hardware

Each of the three signers, on their own machine:

```
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/octora-signer-N.json
# Then move it to a Ledger via the Solana app, OR generate directly on Ledger:
solana-keygen pubkey usb://ledger
```

Record each signer's pubkey. Store the seed phrase in a fireproof safe. The signing keypair file on disk should be immediately deleted after Ledger transfer if you went the disk-then-Ledger route.

**Do not** share keypair files between signers. Each signer must generate independently.

### 2. Create the Squads vault

Use the Squads UI at https://app.squads.so/ on mainnet:

1. Connect signer 1's wallet.
2. Create new multisig:
   - Name: `octora-mainnet-v1`
   - Threshold: 2
   - Add signer 2 and signer 3 pubkeys.
3. Confirm the creation transaction (signer 1 signs).
4. Signer 2 and signer 3 confirm membership.

The Squads UI displays the **vault PDA** for each multisig — that's the address you need.

Alternative CLI flow if you prefer scripting: `@sqds/sdk` has a `multisigCreate` instruction. The UI is faster for first-time setup.

### 3. Record the vault PDA

Add to `01_setup_secrets.txt` (do not commit):

```
SQUADS_VAULT_PDA = <pubkey>
SQUADS_MULTISIG_PDA = <pubkey>     # the multisig account itself
SIGNER_1_PUBKEY    = <pubkey>
SIGNER_2_PUBKEY    = <pubkey>
SIGNER_3_PUBKEY    = <pubkey>
```

### 4. Update the program constants

In `programs/octora-mixer/src/constants.rs`:

```rust
#[cfg(not(feature = "permissionless-init"))]
pub const ADMIN_AUTHORITY: Pubkey = pubkey!("<SQUADS_VAULT_PDA>");
```

Same for `programs/octora-executor/src/constants.rs` if it has a separate constant.

Engineer A applies the change, rebuilds devnet, runs the security tests against the new authority.

### 5. Devnet dress rehearsal (Day 5 of plan)

Before mainnet, exercise the full signing flow on devnet:

1. Deploy a test instance of `octora-mixer` to devnet with `ADMIN_AUTHORITY` set to a devnet Squads vault you created the same way.
2. From the Squads UI, create a `set_paused(true)` transaction proposal.
3. Signer 1 signs the proposal.
4. Signer 2 signs (now ≥ threshold).
5. Anyone executes the now-approved transaction.
6. Confirm `MixerPool.is_paused == true` on devnet.
7. Repeat for `set_paused(false)`.

If this fails on devnet, debug it now — not on mainnet.

### 6. Deploy day (Day 14)

Per `08_MAINNET_DEPLOY_DAY.md`:

1. Deploy with `solana program deploy` from a fresh deployer keypair (NOT a signer key — burn this keypair after).
2. Immediately transfer upgrade authority:
   ```
   solana program set-upgrade-authority <PROGRAM_ID> \
     --new-upgrade-authority <SQUADS_VAULT_PDA>
   ```
3. Confirm transfer:
   ```
   solana program show <PROGRAM_ID>
   ```
   `Authority` should display the Squads vault PDA.
4. Repeat for the second program.

After this point, no future upgrade can land without ≥ 2 of 3 signers.

## Operational policies

- **No upgrade in panic.** A pause via `set_paused(true)` requires only the same 2-of-3 — use that as the first-line response. Upgrades are slower and require an audit-equivalent review.
- **Rotation cadence.** Re-sign the Squads vault PDA with one signer added or replaced every 90 days, just to exercise the flow. Don't wait for a real incident to learn the muscle memory.
- **Loss of one signer.** Recoverable with 2-of-3 (the remaining two can vote to add a new signer and remove the lost one). Document the contact info for each signer's "if I'm unreachable, call X" backup.
- **Loss of two signers.** **Not recoverable.** Programs become unupgradeable forever. Mitigation: signers in three different physical locations, different countries if possible, with off-site seed backups.
- **Pause authority test.** Once a quarter, signer 1 proposes a no-op (e.g., `set_paused(false)` when already false). Confirms the flow is alive.

## Reference

- Squads docs: https://docs.squads.so/main/
- `runbooks/deployment/upgrade-authority.md` (existing) — the inline procedure used during deploy.
- `runbooks/incident/mixer-pause.md` (existing) — the use-this-during-incident steps.
