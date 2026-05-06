# Octora Mixer — Phase-2 Trusted Setup Ceremony

This directory contains the scripts and transcript template for the
multi-party Phase-2 ceremony that produces the production Groth16
verification key for `withdraw.circom`.

## Why this exists

Groth16 has a per-circuit toxic waste. Whoever holds the toxic waste can
forge proofs and drain the mixer. A multi-party ceremony eliminates the
toxic waste as long as **at least one** contributor is honest and
destroys their share. The chain of contributions plus a public-randomness
beacon is what we publish so anyone can audit the security of the setup
post-hoc.

Do NOT use the dev-only `octora-api/src/modules/vault/circuits/setup.sh`
for mainnet. That script uses `date +%s` as entropy (publicly guessable)
and has a single contributor; the toxic waste is recoverable. It is
labeled "octora-devnet-ceremony" intentionally.

## Roles

- **Coordinator** — runs `00-init.sh` once, distributes the initial zkey
  to the first contributor, collects the chain, runs `02-finalize.sh` to
  apply the beacon and publish the final VK. The coordinator is NOT a
  trust anchor — they cannot bias the result if at least one contributor
  is honest.
- **Contributors** — each runs `01-contribute.sh` independently, ideally
  on a machine they own and control, and publishes a signed attestation.
  Mix insiders + community members; 5+ is good, 3 is the floor.
- **Verifiers** — anyone can run `03-verify.sh` to confirm the chain
  validates against the committed circuit and the on-chain Rust VK.

## Process at a glance

```
┌─────────────┐
│ Coordinator │  00-init.sh  →  withdraw_0000.zkey + ptau
└──────┬──────┘
       │ (hand off)
       ▼
┌──────────────┐  01-contribute.sh  →  withdraw_0001.zkey + attestation_1
│ Contributor 1│
└──────┬───────┘
       │ (hand off)
       ▼
┌──────────────┐  01-contribute.sh  →  withdraw_0002.zkey + attestation_2
│ Contributor 2│
└──────┬───────┘
       │ (hand off)
       ▼
       …
       │
       ▼
┌─────────────┐
│ Coordinator │  02-finalize.sh <last.zkey> <btc-block-hash>
└──────┬──────┘             ↓
       │                    withdraw_final.zkey + verification_key.json
       │                    ↓
       │              convert-vk-to-rust.mjs
       │                    ↓
       ▼              programs/octora-mixer/src/verifier/groth16.rs
   cargo build-sbf,
   anchor deploy
```

## Choosing contributors

For a privacy mixer, mix:

- 1–2 core team members (insiders);
- 1–2 trusted community members (e.g. a Solana ZK researcher you have a
  prior relationship with);
- 1+ wildcard (a public Discord/Twitter call for volunteers, vetted by
  the team).

A coordinator-controlled contributor counts as zero. The point of the
ceremony is to have at least one party who is **definitely** independent
of the team.

## Detailed steps

### 0. Coordinator: initialize

```bash
cd scripts/ceremony
bash 00-init.sh
# Outputs:
#   build/withdraw.r1cs
#   build/powersOfTau28_hez_final_14.ptau
#   build/withdraw_0000.zkey
#   build/withdraw_0000.zkey.sha256
#   build/circom-version.txt
```

Publish the SHA256 of `withdraw_0000.zkey` and the circom version
publicly (Twitter / GitHub release notes). Contributors will use this to
verify they're starting from the same initial zkey.

Hand `withdraw_0000.zkey` and the ptau file to **Contributor 1** via a
channel where you can later prove the handoff time (e.g. a signed git
commit, a timestamped tweet, or a tagged release).

### 1. Each contributor

Pre-run checklist:

- [ ] Fresh-booted machine (or live Linux USB).
- [ ] Disconnected from the network during the contribution itself.
- [ ] You verified the input zkey checksum matches what the previous
      contributor (or coordinator) published.
- [ ] You have the circom + snarkjs versions matching `circom-version.txt`.

Run:

```bash
cd scripts/ceremony
# Place the input zkey + ptau into build/
bash 01-contribute.sh \
  build/withdraw_0001.zkey \
  build/withdraw_0002.zkey \
  "Alice <alice@example.com>"
```

The script:

1. Re-verifies the input chain.
2. Sources 1 KiB from `/dev/urandom`, base64-encodes it, hands it to
   snarkjs as the `--entropy` flag.
3. Runs `snarkjs zkey contribute`, which mixes that entropy with its own.
4. Prints the output checksum and writes
   `withdraw_NNNN.attestation.txt` for you to sign and publish.

Post-run checklist:

- [ ] Send the output zkey to the next contributor (or to the
      coordinator if you are last). Public channel is fine — the .zkey
      is not secret; only the toxic waste is, and you destroyed it.
- [ ] Publish your attestation file under your verified identity. Sign
      it with PGP if you have one. The attestation is the part that
      makes you a trust anchor.
- [ ] Wipe the working directory. `shred -u build/*.zkey` on Linux, or
      reboot if running from live USB.

### 2. Coordinator: finalize

After the last contributor has handed off and published their
attestation, wait until a Bitcoin block is mined whose hash you couldn't
have predicted. (Practically: pick the next block AFTER the last
attestation timestamp, then wait 6 blocks for confirmation, then use
that block's hash.) This binds the final zkey to a public future event,
proving the coordinator could not have re-run earlier contributions
adaptively.

```bash
bash 02-finalize.sh \
  build/withdraw_0003.zkey \
  000000000000000000017d4d2c8e3...   # full 64-char block hash
```

This produces:

- `build/withdraw_final.zkey`
- `build/verification_key.json`

The script automatically copies the final VK to
`octora-api/src/modules/vault/circuits/verification_key.json` and the
final zkey to `withdraw.zkey` in the same directory.

### 3. Convert to Rust constants

```bash
node scripts/convert-vk-to-rust.mjs \
  octora-api/src/modules/vault/circuits/verification_key.json
```

Replace the `VK_ALPHA`, `VK_BETA`, `VK_GAMMA`, `VK_DELTA`, and `VK_IC`
blocks in `programs/octora-mixer/src/verifier/groth16.rs` with the
output. Commit the change.

### 4. Build, deploy, publish

```bash
# Reproducible build for the deployed binary
solana-verify build --library-name octora_mixer

# Or, less stringent:
cargo build-sbf -- --no-default-features

anchor deploy --provider.cluster mainnet
```

Then publish a public **transcript bundle** containing:

- Every `withdraw_NNNN.zkey` (or links to where they're hosted).
- Every contributor's signed attestation.
- The Bitcoin block hash and block height used as the beacon.
- The final `verification_key.json` checksum.
- The deployed program ID and the SHA256 of the deployed binary.
- A link to this `CEREMONY.md` and the commit hash that produced it.

The transcript bundle is what auditors and users will use to run
`03-verify.sh` against. Without it, the on-chain VK is just bytes
nobody can prove the provenance of.

## Verifying the ceremony (anyone)

```bash
# Place all .zkey files + the ptau + verification_key.json into
# scripts/ceremony/build/ from the published transcript.
bash scripts/ceremony/03-verify.sh
```

The script will:

1. Verify the Phase-1 ptau checksum.
2. Re-compile `withdraw.circom` and prove the R1CS is bit-identical.
3. Verify each link in the contribution chain.
4. Confirm the on-chain Rust VK constants in `groth16.rs` match the
   ceremony's `verification_key.json`.

What `03-verify.sh` does NOT verify: that any specific contributor was
honest. That is what the published attestations are for — verify
contributor identities and signatures out-of-band.

## Threat model summary

| Failure mode | Mitigated by |
|---|---|
| All contributors collude AND all retain toxic waste | Cannot mitigate in code — solved by choosing diverse, mutually-distrusting contributors |
| Coordinator runs only their own contribution | Mandatory minimum 3 attested contributors, public diversity check |
| Coordinator re-runs contributions adaptively after seeing later ones | Public-randomness beacon (Bitcoin block hash) at the end |
| Compromised contributor machine leaks toxic waste | Air-gapped freshly-booted machine, post-run wipe, multiple contributors so any one honest one suffices |
| Different VK deployed than ceremony produced | `03-verify.sh` step 4 (Rust constants vs ceremony VK) |
| Different circuit compiled into the ceremony than committed | `03-verify.sh` step 2 (R1CS reproducibility) |

## What is the cost of attack?

For an attacker to forge a withdrawal proof, they need to produce
toxic-waste-equivalent data for the **final** zkey. With N contributors
and a beacon, this requires:

- All N contributors to be malicious AND retain their respective shares;
  AND
- The coordinator to also be malicious (the beacon is applied by the
  coordinator, but the beacon input itself is public, so a malicious
  coordinator gains nothing from it on its own).

A single honest contributor who destroys their share — even one
auto-deleted at reboot — is sufficient to make the toxic waste
unrecoverable.
