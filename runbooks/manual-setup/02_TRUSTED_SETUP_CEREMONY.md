# Trusted setup ceremony — Phase 2 Groth16

**Why this matters:** the on-chain mixer verifier accepts any proof that satisfies the verifying key. If the toxic waste from the trusted setup is known to anyone, that party can forge proofs and drain every mixer pool. A multi-party Phase 2 ceremony ensures that as long as **at least one contributor** discards their entropy, no one can forge proofs.

**Closes:** P0-2 (Groth16 trusted setup).

**Tool:** `snarkjs` Phase 2 ceremony.

**Prerequisite:** P0-3 (recipient/relayer/fee binding into the witness) is fixed in code. The circuit is final. **If anyone touches the circuit after the ceremony, the ceremony is invalid and must be re-run.**

## Trust model

- **You need ≥ 3 independent contributors.** Three is the floor; five is comfortable. More contributors = stronger guarantee, but coordination overhead grows.
- **Independence matters.** Three friends in the same room with the same OS image is one contributor in three skins. Each contributor should be on a different machine, different OS where possible, different network.
- **At least one must be honest.** "Honest" = generates entropy from a real source and immediately destroys the toxic waste. If you assume everyone might be malicious, a 100-contributor ceremony still fails. The point is to make collusion of *all* contributors implausible.
- **Different from Squads signers.** Use different humans for ceremony contributors than for Squads signers. Defense in depth.

## Pre-ceremony — Operator (you), Day 1–10

### 1. Lock the circuit

Confirm `octora-api/src/modules/vault/circuits/withdraw.circom` matches the audited version (P0-3 fix landed). Hash the `.r1cs` and `.sym` files; record the hashes.

```
sha256sum withdraw.r1cs withdraw.sym
```

Commit a `runbooks/ceremony/CIRCUIT_HASHES.md` with these hashes. Any contributor must verify these match what they receive.

### 2. Phase 1 (Powers of Tau)

Phase 1 is a universal setup; you do **not** need to run it yourself. Use a published Powers of Tau file from a reputable existing ceremony (e.g., the Hermez Network ceremony — `powersOfTau28_hez_final_15.ptau` for circuits up to 2^15 constraints).

Verify the published file's hash against multiple independent sources (Hermez repo, snarkjs docs, IPFS).

Commit the `.ptau` file to `runbooks/ceremony/phase1/` (or store on IPFS and pin the CID — the file is large).

### 3. Generate initial Phase 2 zkey

```
snarkjs groth16 setup withdraw.r1cs powersOfTau28_hez_final_15.ptau withdraw_0000.zkey
```

Hash and commit:

```
sha256sum withdraw_0000.zkey > runbooks/ceremony/withdraw_0000.zkey.sha256
```

### 4. Schedule the contributors

Send each contributor:

- Date and time of their slot (sequential — contributor 2 starts after contributor 1 finishes).
- Link to their input `.zkey` file (initially `withdraw_0000.zkey`, then the previous contributor's output).
- Hash of the file they should receive.
- Instructions doc (this file, plus a short "what you do" snippet below).
- Way to publish their attestation (PR to this repo, or signed message on social).

Recommended slots: 30 minutes per contributor, with a 30-minute buffer between. Total ceremony time for 3 contributors ≈ 3 hours.

## Ceremony day — Day 11

### Operator script per contributor

For contributor N (N starts at 1):

1. Verify the input file hash matches the published one. If not, halt — the chain is broken.
2. Receive the contributor's output `.zkey` and beacon (if they used one).
3. Run verification:
   ```
   snarkjs zkey verify withdraw.r1cs powersOfTau28_hez_final_15.ptau withdraw_000N.zkey
   ```
   If this fails, the contribution is rejected; ask the contributor to redo or move on with N+1.
4. Hash the output:
   ```
   sha256sum withdraw_000N.zkey > runbooks/ceremony/withdraw_000N.zkey.sha256
   ```
5. Publish hash + contributor attestation to `runbooks/ceremony/transcripts/contributor_N.md`:
   ```
   # Contributor N attestation

   Name / handle:
   Public statement:
   Input zkey hash:
   Output zkey hash:
   Date / time (UTC):
   Entropy source:    # e.g., "/dev/urandom + die rolls + audio noise"
   Entropy destruction: # e.g., "VM destroyed; disk wiped"
   Beacon:           # if applied — e.g., "Bitcoin block 850000 hash"

   I attest that I generated entropy as described, ran the contribution, and destroyed all material related to entropy generation immediately afterward. To the best of my ability I cannot reconstruct the contribution.

   Signature: <signed by contributor's pubkey>
   ```
6. Hand the output `.zkey` off to contributor N+1 (or finalize after the last contributor).

### Contributor instructions (send this snippet to each contributor)

```
You're contributing to the Octora mixer trusted setup.

1. Install snarkjs:
   npm i -g snarkjs

2. Verify the input file hash matches what we sent:
   sha256sum withdraw_<prev>.zkey
   Compare to: <hash sent by operator>

3. Run your contribution. Provide HIGH-ENTROPY input — slap your keyboard, paste from /dev/urandom, mix in audio noise. snarkjs will mix everything you provide:
   snarkjs zkey contribute withdraw_<prev>.zkey withdraw_<yours>.zkey \
     --name="<your handle>" -v

4. Optionally apply a beacon (random value committed before the ceremony — e.g., a future Bitcoin block hash):
   snarkjs zkey beacon withdraw_<yours>.zkey withdraw_<yours>_beacon.zkey \
     <beacon-hex> 10 --name="<beacon description>"

5. Hash and publish:
   sha256sum withdraw_<yours>*.zkey

6. SEND BACK to operator:
   - The output .zkey file
   - The hash
   - Your attestation (template provided)

7. DESTROY all entropy material:
   - rm withdraw_<prev>.zkey   (you don't need to keep it)
   - Wipe any temp files snarkjs created in /tmp
   - If you used a VM, destroy the VM
   - If you used a physical machine, no special cleanup needed beyond /tmp,
     but do not back up your machine state including snarkjs runtime memory

   The toxic waste is RAM-resident during contribution. Process exit kills it.
   Do not save a memory dump.
```

### After all contributors

Operator finalizes:

```
snarkjs zkey beacon withdraw_<final>.zkey withdraw_final.zkey \
  <random-hex> 10 --name="Final beacon"

snarkjs zkey verify withdraw.r1cs powersOfTau28_hez_final_15.ptau withdraw_final.zkey

snarkjs zkey export verificationkey withdraw_final.zkey verification_key.json

sha256sum withdraw_final.zkey verification_key.json
```

Commit `verification_key.json` and the final hash to `runbooks/ceremony/`.

## Re-derive the on-chain VK

Engineer A converts the final `verification_key.json` to the byte representation hardcoded in `programs/octora-mixer/src/verifier/groth16.rs`:

1. The current code has a fixed VK byte layout — see the comments around lines 163–170.
2. There's likely a helper script in `octora-api/src/scripts/` or similar that emits the bytes in the right format. If not, this is `JSON → field elements → big-endian bytes` per the Groth16 verifier convention.
3. Replace the hardcoded bytes.
4. Run all mixer security tests against the new VK. They must pass with proofs generated using `withdraw_final.zkey`.

```
cd programs/octora-mixer
cargo build-sbf
anchor test  # verifies new VK accepts good proofs and rejects bad ones
```

If tests pass, the ceremony is complete and the program is ready to build for mainnet.

## What to commit

To `runbooks/ceremony/`:

- `CIRCUIT_HASHES.md` — hashes of the .r1cs / .sym used.
- `phase1/` — Powers of Tau file (or IPFS CID).
- `withdraw_0000.zkey.sha256`
- `withdraw_000N.zkey.sha256` for each contributor
- `withdraw_final.zkey.sha256`
- `verification_key.json` and its hash
- `transcripts/contributor_N.md` for each contributor

**Do NOT commit any `.zkey` file other than the final one** — they are not secret but they're large. Final `.zkey` is committed because it's the one that matters; intermediate ones are reproducible from the chain of contributions if needed for audit.

## Audit trail

Anyone reviewing the ceremony post-hoc should be able to:

1. Read `verification_key.json`.
2. Confirm it matches the bytes hardcoded in `groth16.rs`.
3. Walk back through the transcripts to confirm ≥ 3 independent contributors, each with attestation.
4. Verify each transcript's hash chain matches the next.

Document this audit procedure in `runbooks/ceremony/AUDIT.md` for future reviewers.

## What NOT to do

- ❌ Run all contributions on the same machine.
- ❌ Use a CI runner as a contributor.
- ❌ Skip entropy verification.
- ❌ Re-run a contribution after circuit changes — circuit is now committed; if you change it, restart the ceremony.
- ❌ Publish a "summary" that omits transcripts — the transcripts are the audit trail.
- ❌ Use one of your Squads signers as a ceremony contributor — defeats independence.

## Reference

- snarkjs Phase 2 docs: https://github.com/iden3/snarkjs#groth16
- Tornado Cash ceremony post-mortem: searches for "Tornado Cash trusted setup transcripts" — useful template for transcript format.
- Existing `runbooks/ceremony/PROCEDURE.md` — the more terse internal procedure; this file is the operator-friendly version.
