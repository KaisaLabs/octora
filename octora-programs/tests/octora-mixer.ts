import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import { buildPoseidon } from "circomlibjs";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Constants matching on-chain program ───────────────────────────────
const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const NULLIFIER_SEED = Buffer.from("nullifier");
const COMMITMENT_SEED = Buffer.from("commitment");
const TREE_LEVELS = 20;
const DENOMINATION = new anchor.BN(LAMPORTS_PER_SOL / 100); // 0.01 SOL (devnet-friendly)

// ─── Poseidon setup ────────────────────────────────────────────────────

let poseidon: any;

async function initPoseidon() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

function poseidonHash(inputs: bigint[]): bigint {
  const p = poseidon;
  const hash = p(inputs.map((x: bigint) => p.F.e(x)));
  return BigInt(p.F.toString(hash));
}

// ─── Crypto helpers ────────────────────────────────────────────────────

function randomFieldElement(): bigint {
  const bytes = randomBytes(31);
  return BigInt("0x" + bytes.toString("hex"));
}

function generateCommitment() {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  const commitment = poseidonHash([secret, nullifier]);
  const nullifierHash = poseidonHash([nullifier]);
  return { secret, nullifier, commitment, nullifierHash };
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/**
 * Bind a pubkey to a single BN254 field element via Poseidon(hi, lo)
 * over the two 16-byte halves of the pubkey bytes. Mirrors the on-chain
 * `pubkey_to_field_hash` helper. Replaces the previous mod-r reduction.
 */
function pubkeyToFieldHash(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  const hi = BigInt("0x" + Buffer.from(bytes.slice(0, 16)).toString("hex"));
  const lo = BigInt("0x" + Buffer.from(bytes.slice(16, 32)).toString("hex"));
  return poseidonHash([hi, lo]);
}

function bigintToArray32(value: bigint): number[] {
  return Array.from(bigintToBytes32(value));
}

// ─── Merkle tree helpers ───────────────────────────────────────────────

function computeZeroHashes(): bigint[] {
  const hashes: bigint[] = [];
  let current = 0n;
  for (let i = 0; i < TREE_LEVELS; i++) {
    current = poseidonHash([current, current]);
    hashes.push(current);
  }
  return hashes;
}

/** Compute the full Merkle root from a set of leaves. */
function computeRoot(leaves: bigint[], zeroHashes: bigint[]): bigint {
  // Build full bottom level
  const levelSize = 1 << TREE_LEVELS;
  let currentLevel: bigint[] = [];
  for (let i = 0; i < levelSize; i++) {
    currentLevel.push(i < leaves.length ? leaves[i] : 0n);
  }

  for (let level = 0; level < TREE_LEVELS; level++) {
    const nextLevel: bigint[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(poseidonHash([currentLevel[i], currentLevel[i + 1]]));
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/** Compute Merkle proof (pathElements + pathIndices) for a given leaf. */
function computeMerkleProof(
  leaves: bigint[],
  leafIndex: number,
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  const levelSize = 1 << TREE_LEVELS;
  let currentLevel: bigint[] = [];
  for (let i = 0; i < levelSize; i++) {
    currentLevel.push(i < leaves.length ? leaves[i] : 0n);
  }

  let idx = leafIndex;
  for (let level = 0; level < TREE_LEVELS; level++) {
    const siblingIdx = idx ^ 1;
    pathElements.push(currentLevel[siblingIdx]);
    pathIndices.push(idx & 1);

    const nextLevel: bigint[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(poseidonHash([currentLevel[i], currentLevel[i + 1]]));
    }
    currentLevel = nextLevel;
    idx = idx >> 1;
  }

  return { pathElements, pathIndices };
}

// ─── PDA helpers ───────────────────────────────────────────────────────

function deriveMixerPoolPDA(programId: PublicKey, denomination: anchor.BN): [PublicKey, number] {
  const denomBuf = denomination.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync([MIXER_POOL_SEED, denomBuf], programId);
}

function deriveCommitmentPDA(
  programId: PublicKey, poolKey: PublicKey, commitment: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, poolKey.toBuffer(), commitment], programId,
  );
}

function deriveNullifierPDA(
  programId: PublicKey, poolKey: PublicKey, nullifierHash: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, poolKey.toBuffer(), nullifierHash], programId,
  );
}

// ─── Proof byte conversion ────────────────────────────────────────────

function convertProofToBytes(proof: any): Buffer {
  const buf = Buffer.alloc(256);
  const BN254_P = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
  bigintToBe32(BigInt(proof.pi_a[0])).copy(buf, 0);
  bigintToBe32(BN254_P - BigInt(proof.pi_a[1])).copy(buf, 32); // negate y
  bigintToBe32(BigInt(proof.pi_b[0][1])).copy(buf, 64);
  bigintToBe32(BigInt(proof.pi_b[0][0])).copy(buf, 96);
  bigintToBe32(BigInt(proof.pi_b[1][1])).copy(buf, 128);
  bigintToBe32(BigInt(proof.pi_b[1][0])).copy(buf, 160);
  bigintToBe32(BigInt(proof.pi_c[0])).copy(buf, 192);
  bigintToBe32(BigInt(proof.pi_c[1])).copy(buf, 224);
  return buf;
}

function convertPublicInputsToBytes(signals: string[]): Buffer {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 5; i++) {
    bigintToBe32(BigInt(signals[i])).copy(buf, i * 32);
  }
  return buf;
}

function bigintToBe32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// ─── Helper: deposit a commitment ──────────────────────────────────────

async function doDeposit(
  program: Program,
  programId: PublicKey,
  mixerPoolPDA: PublicKey,
  authority: anchor.Wallet,
  commitment: bigint,
  allLeaves: bigint[], // leaves AFTER inserting this commitment, used to assert
  zeroHashes: bigint[],
) {
  const commitmentBytes = bigintToBytes32(commitment);
  const [commitmentPDA] = deriveCommitmentPDA(programId, mixerPoolPDA, commitmentBytes);

  // The on-chain program now computes the new root deterministically via the
  // Solana Poseidon syscall — no off-chain root passed in. We still compute
  // the expected root locally so the test can assert parity below.
  const expectedRoot = computeRoot(allLeaves, zeroHashes);

  // The on-chain insertion does TREE_LEVELS (=20) Poseidon syscalls, so
  // bump the compute budget the same way the API service does.
  const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  await program.methods
    .deposit(Array.from(commitmentBytes))
    .accounts({
      depositor: authority.publicKey,
      mixerPool: mixerPoolPDA,
      commitmentAccount: commitmentPDA,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeIx])
    .rpc();

  return expectedRoot;
}

/** Fund an account by transferring SOL from authority (avoids airdrop rate limits on devnet). */
async function fundAccount(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number,
) {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  await provider.sendAndConfirm(tx);
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("octora-mixer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraMixer as Program;
  const programId = program.programId;
  const authority = provider.wallet as anchor.Wallet;

  let mixerPoolPDA: PublicKey;
  let zeroHashes: bigint[];
  const depositedLeaves: bigint[] = [];

  before(async () => {
    await initPoseidon();
    zeroHashes = computeZeroHashes();
    [mixerPoolPDA] = deriveMixerPoolPDA(programId, DENOMINATION);
  });

  // ── Test 1: Initialize ─────────────────────────────────────────────

  describe("initialize", () => {
    it("creates a mixer pool with correct initial state", async () => {
      await program.methods
        .initialize(DENOMINATION)
        .accounts({
          authority: authority.publicKey,
          mixerPool: mixerPoolPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const pool = await program.account.mixerPool.fetch(mixerPoolPDA);

      expect(pool.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(pool.denomination.toNumber()).to.equal(DENOMINATION.toNumber());
      expect(pool.nextLeafIndex).to.equal(0);
      expect(pool.currentRootIndex).to.equal(0);
      expect(pool.isPaused).to.equal(false);

      // Verify initial root = ZERO_HASHES[19] (empty tree root)
      const expectedRoot = bigintToArray32(zeroHashes[TREE_LEVELS - 1]);
      const actualRoot = Array.from(pool.rootHistory[0] as number[]);
      expect(actualRoot).to.deep.equal(expectedRoot);
    });
  });

  // ── Test 2: Deposit ────────────────────────────────────────────────

  describe("deposit", () => {
    it("accepts a valid deposit and computes the new root on-chain", async () => {
      const { commitment } = generateCommitment();

      const balanceBefore = await provider.connection.getBalance(mixerPoolPDA);

      // Add to local leaves; doDeposit returns the locally-expected root so
      // we can assert the on-chain Poseidon syscall produced the same value.
      depositedLeaves.push(commitment);
      const expectedRoot = await doDeposit(
        program, programId, mixerPoolPDA, authority, commitment, depositedLeaves, zeroHashes,
      );

      const pool = await program.account.mixerPool.fetch(mixerPoolPDA);
      expect(pool.nextLeafIndex).to.equal(1);

      // Verify SOL transferred
      const balanceAfter = await provider.connection.getBalance(mixerPoolPDA);
      expect(balanceAfter - balanceBefore).to.be.greaterThanOrEqual(DENOMINATION.toNumber());

      // The root the on-chain program pushed must match the off-chain
      // Poseidon-tree computation byte-for-byte. This is the key assertion
      // for the audit's "untrusted new_root" fix.
      const onChainRoot = Array.from(pool.rootHistory[pool.currentRootIndex] as number[]);
      const expectedRootBytes = bigintToArray32(expectedRoot);
      expect(onChainRoot).to.deep.equal(expectedRootBytes);
    });

    // ── Test 3: Reject duplicate commitment ────────────────────────

    it("rejects a duplicate commitment", async () => {
      const commitment = depositedLeaves[0];
      const commitmentBytes = bigintToBytes32(commitment);
      const [commitmentPDA] = deriveCommitmentPDA(programId, mixerPoolPDA, commitmentBytes);

      const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

      try {
        await program.methods
          .deposit(Array.from(commitmentBytes))
          .accounts({
            depositor: authority.publicKey,
            mixerPool: mixerPoolPDA,
            commitmentAccount: commitmentPDA,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeIx])
          .rpc();

        expect.fail("Should have thrown on duplicate commitment");
      } catch (err: any) {
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ── Test 4: Full deposit → proof → withdraw flow ──────────────────

  describe("full withdrawal flow", () => {
    let depositCommitment: ReturnType<typeof generateCommitment>;
    let recipientKeypair: Keypair;
    let depositLeafIndex: number;

    before(async () => {
      // Make a fresh deposit for withdrawal testing
      depositCommitment = generateCommitment();
      depositLeafIndex = depositedLeaves.length;
      depositedLeaves.push(depositCommitment.commitment);

      await doDeposit(
        program, programId, mixerPoolPDA, authority,
        depositCommitment.commitment, depositedLeaves, zeroHashes,
      );

      recipientKeypair = Keypair.generate();
      await fundAccount(provider, recipientKeypair.publicKey, 5_000_000); // 0.005 SOL for rent
    });

    it("withdraws with a valid Groth16 proof", async () => {
      const snarkjs = await import("snarkjs");

      const testDir = dirname(fileURLToPath(import.meta.url));
      const wasmPath = join(testDir, "..", "octora-api", "src", "modules", "vault", "circuits", "withdraw.wasm");
      const zkeyPath = join(testDir, "..", "octora-api", "src", "modules", "vault", "circuits", "withdraw.zkey");

      if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
        console.log("    ⚠ Circuit artifacts not found, skipping");
        return;
      }

      const root = computeRoot(depositedLeaves, zeroHashes);
      const proof = computeMerkleProof(depositedLeaves, depositLeafIndex);

      const recipientField = pubkeyToFieldHash(recipientKeypair.publicKey);
      const relayerField = pubkeyToFieldHash(authority.publicKey);

      const inputs = {
        root: root.toString(),
        nullifierHash: depositCommitment.nullifierHash.toString(),
        recipient: recipientField.toString(),
        relayer: relayerField.toString(),
        fee: "0",
        secret: depositCommitment.secret.toString(),
        nullifier: depositCommitment.nullifier.toString(),
        pathElements: proof.pathElements.map(String),
        pathIndices: proof.pathIndices,
      };

      const { proof: groth16Proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs, wasmPath, zkeyPath,
      );

      const proofBytes = convertProofToBytes(groth16Proof);
      const publicInputsBytes = convertPublicInputsToBytes(publicSignals);

      const nullifierHashBytes = bigintToBytes32(depositCommitment.nullifierHash);
      const [nullifierPDA] = deriveNullifierPDA(programId, mixerPoolPDA, nullifierHashBytes);

      const recipientBalanceBefore = await provider.connection.getBalance(recipientKeypair.publicKey);

      await program.methods
        .withdraw(Array.from(proofBytes), Array.from(publicInputsBytes))
        .accounts({
          signer: authority.publicKey,
          mixerPool: mixerPoolPDA,
          nullifierAccount: nullifierPDA,
          recipient: recipientKeypair.publicKey,
          relayer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .rpc();

      const recipientBalanceAfter = await provider.connection.getBalance(recipientKeypair.publicKey);
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(DENOMINATION.toNumber());

      const nullifierAccount = await provider.connection.getAccountInfo(nullifierPDA);
      expect(nullifierAccount).to.not.be.null;
    });

    // ── Test 5: Reject double-spend ────────────────────────────────

    it("rejects double-spend with same nullifier", async () => {
      const nullifierHashBytes = bigintToBytes32(depositCommitment.nullifierHash);
      const [nullifierPDA] = deriveNullifierPDA(programId, mixerPoolPDA, nullifierHashBytes);

      const existingAccount = await provider.connection.getAccountInfo(nullifierPDA);
      if (!existingAccount) {
        console.log("    ⚠ Previous withdraw test was skipped, skipping double-spend test");
        return;
      }

      const dummyProof = new Array(256).fill(0);
      const dummyInputs = new Array(160).fill(0);

      try {
        await program.methods
          .withdraw(dummyProof, dummyInputs)
          .accounts({
            signer: authority.publicKey,
            mixerPool: mixerPoolPDA,
            nullifierAccount: nullifierPDA,
            recipient: Keypair.generate().publicKey,
            relayer: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .rpc();

        expect.fail("Should have thrown on double-spend");
      } catch (err: any) {
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ── Test 6: Reject invalid proof ──────────────────────────────────

  describe("invalid proof rejection", () => {
    it("rejects a withdrawal with garbage proof data", async () => {
      const nullifierHash = randomFieldElement();
      const nullifierHashBytes = bigintToBytes32(nullifierHash);
      const [nullifierPDA] = deriveNullifierPDA(programId, mixerPoolPDA, nullifierHashBytes);

      const pool = await program.account.mixerPool.fetch(mixerPoolPDA);
      const currentRoot = pool.rootHistory[pool.currentRootIndex] as number[];

      const recipientKeypair = Keypair.generate();
      const recipientField = pubkeyToFieldHash(recipientKeypair.publicKey);
      const relayerField = pubkeyToFieldHash(authority.publicKey);

      const publicInputs = Buffer.alloc(160);
      Buffer.from(currentRoot).copy(publicInputs, 0);
      bigintToBytes32(nullifierHash).copy(publicInputs, 32);
      bigintToBytes32(recipientField).copy(publicInputs, 64);
      bigintToBytes32(relayerField).copy(publicInputs, 96);
      Buffer.alloc(32).copy(publicInputs, 128); // fee = 0

      const garbageProof = Buffer.alloc(256);
      randomBytes(256).copy(garbageProof);

      await fundAccount(provider, recipientKeypair.publicKey, 5_000_000); // 0.005 SOL for rent

      try {
        await program.methods
          .withdraw(Array.from(garbageProof), Array.from(publicInputs))
          .accounts({
            signer: authority.publicKey,
            mixerPool: mixerPoolPDA,
            nullifierAccount: nullifierPDA,
            recipient: recipientKeypair.publicKey,
            relayer: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .rpc();

        expect.fail("Should have thrown on invalid proof");
      } catch (err: any) {
        const errStr = err.toString();
        const isExpected =
          errStr.includes("InvalidProof") ||
          errStr.includes("custom program error") ||
          errStr.includes("failed");
        expect(isExpected).to.be.true;
      }
    });
  });

  // ── Test 7: Reject expired root ───────────────────────────────────

  describe("expired root rejection", () => {
    it("rejects withdrawal with a root not in history", async () => {
      const nullifierHash = randomFieldElement();
      const nullifierHashBytes = bigintToBytes32(nullifierHash);
      const [nullifierPDA] = deriveNullifierPDA(programId, mixerPoolPDA, nullifierHashBytes);

      const recipientKeypair = Keypair.generate();
      const recipientField = pubkeyToFieldHash(recipientKeypair.publicKey);
      const relayerField = pubkeyToFieldHash(authority.publicKey);

      const fakeRoot = bigintToBytes32(randomFieldElement());

      const publicInputs = Buffer.alloc(160);
      fakeRoot.copy(publicInputs, 0);
      bigintToBytes32(nullifierHash).copy(publicInputs, 32);
      bigintToBytes32(recipientField).copy(publicInputs, 64);
      bigintToBytes32(relayerField).copy(publicInputs, 96);
      Buffer.alloc(32).copy(publicInputs, 128);

      const dummyProof = Buffer.alloc(256);

      await fundAccount(provider, recipientKeypair.publicKey, 5_000_000); // 0.005 SOL for rent

      try {
        await program.methods
          .withdraw(Array.from(dummyProof), Array.from(publicInputs))
          .accounts({
            signer: authority.publicKey,
            mixerPool: mixerPoolPDA,
            nullifierAccount: nullifierPDA,
            recipient: recipientKeypair.publicKey,
            relayer: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .rpc();

        expect.fail("Should have thrown on expired/unknown root");
      } catch (err: any) {
        if (err instanceof AnchorError) {
          expect(err.error.errorCode.code).to.equal("RootNotFound");
        } else {
          expect(err.toString()).to.include("RootNotFound");
        }
      }
    });
  });
});
