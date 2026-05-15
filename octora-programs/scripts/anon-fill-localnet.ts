/**
 * Anonymity-set fill script — localnet (and devnet) testing harness.
 *
 * Pumps `mixer.deposit` instructions into one or more denomination pools
 * from many fresh, single-use keypairs so the on-chain anonymity set
 * grows realistically (no same-wallet clustering). Persists every
 * (secret, nullifier, commitment, leafIndex, denomination) tuple to a
 * JSON witness file so the seed SOL stays recoverable via the standard
 * Groth16-prove + relayer-withdraw flow.
 *
 * See docs/anonymity-fill-strategy.html for the full playbook.
 *
 * Required env:
 *   OCTORA_MIXER_PROGRAM_ID       — deployed mixer program id
 *   OCTORA_MIXER_ADMIN_KEYPAIR    — funder keypair (will pay for fresh wallets)
 *
 * Optional env:
 *   OCTORA_EXECUTOR_RPC_URL       — defaults to http://127.0.0.1:8899
 *   ANON_FILL_PER_DENOM           — deposits per denomination (default 30)
 *   ANON_FILL_DENOMS              — comma-separated denoms in lamports
 *                                   (default: read MIXER_DENOMINATIONS, else 0.1/1/5/10 SOL)
 *   ANON_FILL_MIN_DELAY_MS        — min inter-deposit pause (default 200)
 *   ANON_FILL_MAX_DELAY_MS        — max inter-deposit pause (default 2000)
 *   ANON_FILL_WITNESS_FILE        — output witness path (default scripts/.anon-fill-witnesses.json)
 *   ANON_FILL_RENT_BUFFER_LAMPORTS — extra lamports to fund per fresh wallet on top
 *                                   of `denom` (covers commitment-account rent + tx fee).
 *                                   Default 5_000_000 (~0.005 SOL).
 *
 * Usage:
 *   pnpm tsx scripts/anon-fill-localnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { buildPoseidon } from "circomlibjs";
import type { OctoraMixer } from "../target/types/octora_mixer";

const ENV_FILE = resolve(process.cwd(), ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");

const DEFAULT_DENOMINATIONS: bigint[] = [
  100_000_000n,
  1_000_000_000n,
  5_000_000_000n,
  10_000_000_000n,
];

interface WitnessRow {
  ts: string;
  denominationLamports: string;
  poolPda: string;
  depositorPubkey: string;
  depositorSecretKeyBase64: string; // single-use, recovery-only
  secret: string;
  nullifier: string;
  commitment: string;
  nullifierHash: string;
  leafIndex: number;
  txSignature: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(resolve(path), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function parseDenominations(): bigint[] {
  const raw =
    process.env.ANON_FILL_DENOMS?.trim() ??
    process.env.MIXER_DENOMINATIONS?.trim();
  if (!raw) return DEFAULT_DENOMINATIONS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
  return parsed.length > 0 ? parsed : DEFAULT_DENOMINATIONS;
}

function parseInt32(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${raw})`);
  }
  return v;
}

function parseBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  return BigInt(raw);
}

/** Pack a bigint into exactly 32 big-endian bytes. Mirrors octora-api's bigintToBytes32. */
function bigintToBytes32BE(value: bigint, field: string): Buffer {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`${field} value out of range: ${value.toString()}`);
  }
  const out = Buffer.alloc(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Generate a uniformly random 31-byte (≤ 248 bit) BN254 field element. */
function randomFieldElement(): bigint {
  const bytes = new Uint8Array(31);
  // crypto.getRandomValues is on globalThis in Node 20+
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function uniformInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function main() {
  const programId = new PublicKey(requireEnv("OCTORA_MIXER_PROGRAM_ID"));
  const adminPath = requireEnv("OCTORA_MIXER_ADMIN_KEYPAIR");
  const rpcUrl =
    process.env.OCTORA_EXECUTOR_RPC_URL ?? "http://127.0.0.1:8899";

  const denominations = parseDenominations();
  const perDenom = parseInt32("ANON_FILL_PER_DENOM", 30);
  const minDelayMs = parseInt32("ANON_FILL_MIN_DELAY_MS", 200);
  const maxDelayMs = parseInt32("ANON_FILL_MAX_DELAY_MS", 2000);
  const rentBuffer = parseBigint("ANON_FILL_RENT_BUFFER_LAMPORTS", 5_000_000n);
  const witnessFile = resolve(
    process.env.ANON_FILL_WITNESS_FILE ?? "scripts/.anon-fill-witnesses.json",
  );

  if (maxDelayMs < minDelayMs) {
    throw new Error("ANON_FILL_MAX_DELAY_MS must be >= ANON_FILL_MIN_DELAY_MS");
  }

  const admin = loadKeypair(adminPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(admin),
    { commitment: "confirmed" },
  );

  const idlPath = resolve(__dirname, "../target/idl/octora_mixer.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();
  const program = new anchor.Program<OctoraMixer>(idl, provider);

  console.log("Anonymity-set fill — localnet/devnet");
  console.log(`  rpc:           ${rpcUrl}`);
  console.log(`  program:       ${programId.toBase58()}`);
  console.log(`  funder:        ${admin.publicKey.toBase58()}`);
  console.log(`  denoms:        ${denominations.map((d) => d.toString()).join(", ")} lamports`);
  console.log(`  per-denom:     ${perDenom}`);
  console.log(`  delay range:   ${minDelayMs}–${maxDelayMs} ms`);
  console.log(`  witness file:  ${witnessFile}`);
  console.log();

  // Initialize witness file as a JSON array if it doesn't exist. We append
  // each row by rewriting the closing `]` — atomic enough for a single-
  // process script and survives mid-run kill without losing earlier rows.
  if (!existsSync(witnessFile)) {
    writeFileSync(witnessFile, "[\n]\n", "utf8");
  }

  // Resolve every pool PDA up front + verify it exists. Bail loudly if a
  // requested denom hasn't been initialised — running otherwise would just
  // fail every deposit with AccountNotInitialized and waste fees.
  const pools = await Promise.all(
    denominations.map(async (denom) => {
      const denomBuf = Buffer.alloc(8);
      denomBuf.writeBigUInt64LE(denom);
      const [poolPda] = PublicKey.findProgramAddressSync(
        [MIXER_POOL_SEED, denomBuf],
        programId,
      );
      const info = await connection.getAccountInfo(poolPda);
      if (!info) {
        throw new Error(
          `Mixer pool not found for denom ${denom} (PDA ${poolPda.toBase58()}). ` +
            `Run: pnpm tsx scripts/init-mixer-pools.ts`,
        );
      }
      return { denom, poolPda };
    }),
  );

  // Sanity-check funder balance before we start firing deposits.
  const totalLamportsNeeded = denominations.reduce(
    (acc, d) => acc + (d + rentBuffer) * BigInt(perDenom),
    0n,
  );
  const adminBalance = BigInt(await connection.getBalance(admin.publicKey));
  console.log(
    `  funder balance: ${adminBalance} lamports, projected need ≥ ${totalLamportsNeeded} lamports`,
  );
  if (adminBalance < totalLamportsNeeded) {
    throw new Error(
      `Funder underfunded. Need ${totalLamportsNeeded}, have ${adminBalance}. ` +
        `Top up: solana airdrop 100 ${admin.publicKey.toBase58()} -u ${rpcUrl}`,
    );
  }

  // Build poseidon once — circomlibjs is async-init.
  const poseidon = (await buildPoseidon()) as ((
    inputs: unknown[],
  ) => Uint8Array) & {
    F: { e(v: bigint): unknown; toString(v: unknown): string };
  };
  const hash = (xs: bigint[]): bigint => {
    const out = poseidon(xs.map((x) => poseidon.F.e(x)));
    return BigInt(poseidon.F.toString(out));
  };

  let total = 0;
  let failures = 0;

  // Round-robin across denoms so the fill grows pools in lockstep instead
  // of finishing one denom before the next starts. Better mimics organic
  // deposit traffic.
  const queue: { denom: bigint; poolPda: PublicKey }[] = [];
  for (let i = 0; i < perDenom; i++) {
    for (const p of pools) queue.push(p);
  }

  for (const job of queue) {
    const depositor = Keypair.generate();
    const fundLamports = job.denom + rentBuffer;

    try {
      // 1. Fund the fresh depositor from the admin wallet.
      const fundSig = await connection.sendTransaction(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: depositor.publicKey,
            lamports: Number(fundLamports),
          }),
        ),
        [admin],
        { preflightCommitment: "confirmed" },
      );
      await connection.confirmTransaction(fundSig, "confirmed");

      // 2. Generate a real (secret, nullifier) → commitment so the seed
      //    deposit is recoverable via the standard withdraw flow.
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = hash([secret, nullifier]);
      const nullifierHash = hash([nullifier]);
      const commitmentBytes = bigintToBytes32BE(commitment, "commitment");

      // 3. Read leaf index BEFORE submitting so we know where this commitment
      //    will land. Race-free because this script is single-tab.
      const poolStateRaw = await program.account.mixerPool.fetch(job.poolPda);
      const leafIndex = Number(poolStateRaw.nextLeafIndex);

      // 4. Submit mixer.deposit signed by the fresh depositor.
      const sig = await program.methods
        .deposit(Array.from(commitmentBytes) as number[])
        .accountsPartial({
          depositor: depositor.publicKey,
          mixerPool: job.poolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc({ commitment: "confirmed" });

      // 5. Persist witness — so the seed SOL stays recoverable. Append-only.
      const row: WitnessRow = {
        ts: new Date().toISOString(),
        denominationLamports: job.denom.toString(),
        poolPda: job.poolPda.toBase58(),
        depositorPubkey: depositor.publicKey.toBase58(),
        depositorSecretKeyBase64: Buffer.from(depositor.secretKey).toString("base64"),
        secret: secret.toString(),
        nullifier: nullifier.toString(),
        commitment: commitment.toString(),
        nullifierHash: nullifierHash.toString(),
        leafIndex,
        txSignature: sig,
      };
      appendWitness(witnessFile, row, total === 0);

      total += 1;
      console.log(
        `  [${String(total).padStart(4)}] denom=${job.denom} leaf=${leafIndex} ` +
          `tx=${sig.slice(0, 12)}…  depositor=${depositor.publicKey.toBase58().slice(0, 8)}…`,
      );
    } catch (err) {
      failures += 1;
      console.error(
        `  FAIL denom=${job.denom} depositor=${depositor.publicKey.toBase58().slice(0, 8)}…: ${
          (err as Error).message
        }`,
      );
    }

    await sleep(uniformInt(minDelayMs, maxDelayMs));
  }

  // Final per-denom counts so the operator can verify the set grew.
  console.log("\nFinal pool state:");
  for (const p of pools) {
    const state = await program.account.mixerPool.fetch(p.poolPda);
    console.log(
      `  denom=${p.denom.toString().padStart(12)} lamports  next_leaf_index=${state.nextLeafIndex}  pda=${p.poolPda.toBase58()}`,
    );
  }
  console.log(`\nDone. Submitted: ${total}, failed: ${failures}.`);
  console.log(`Witnesses persisted to: ${witnessFile}`);
  console.log(
    "REMINDER: that file is the only path to recover the seed SOL. Back it up before re-running.",
  );
}

/**
 * Append a row to the witness file by rewriting the trailing `]\n`. Cheap
 * for the volumes this script targets (≤ low thousands of rows). Atomic
 * enough that a kill mid-iteration loses at most the in-flight row, not
 * the prior history.
 */
function appendWitness(path: string, row: WitnessRow, isFirst: boolean): void {
  const raw = readFileSync(path, "utf8");
  // strip the trailing "]\n"
  const trimmed = raw.replace(/\]\s*$/, "");
  const sep = isFirst && trimmed.trim().endsWith("[") ? "" : ",\n";
  const payload = `${trimmed}${sep}  ${JSON.stringify(row)}\n]\n`;
  writeFileSync(path, payload, "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
