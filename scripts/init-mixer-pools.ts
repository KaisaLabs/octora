import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { OctoraMixer } from "../target/types/octora_mixer";

// Auto-load the repo-root .env so `pnpm tsx scripts/init-mixer-pools.ts`
// works without an external `--env-file` or shell-source step. Same contract
// as the singular `init-mixer-pool.ts`: run from the repo root.
const ENV_FILE = resolve(process.cwd(), ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const MIXER_POOL_SEED = Buffer.from("mixer_pool");

// Default denominations match `MIXER_DENOMINATIONS` default in
// octora-api/src/common/config/index.ts and the Denomination ladder
// ticket (.scratch/dust-and-stuck-funds/issues/07-denom-ladder.md):
// {0.1, 1, 5, 10} SOL. Smaller buckets give tighter DLMM price-range
// fits (less residual dust); larger buckets fragment the Anonymity
// Set, which is why MIN_ANONYMITY_SET=20 is enforced per pool.
//
// Keep this list in sync with `init-surfpool.ts`'s DEFAULT_DENOMINATIONS
// and with `MIXER_DENOMINATIONS` in octora-api config.
const DEFAULT_DENOMINATIONS: bigint[] = [
  100_000_000n,
  1_000_000_000n,
  5_000_000_000n,
  10_000_000_000n,
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(resolve(path), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function parseDenominations(): bigint[] {
  const raw = process.env.MIXER_DENOMINATIONS?.trim();
  if (!raw) return DEFAULT_DENOMINATIONS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
  if (parsed.length === 0) return DEFAULT_DENOMINATIONS;
  return parsed;
}

async function main() {
  const programId = new PublicKey(requireEnv("OCTORA_MIXER_PROGRAM_ID"));
  const adminPath = requireEnv("OCTORA_MIXER_ADMIN_KEYPAIR");
  const rpcUrl =
    process.env.OCTORA_EXECUTOR_RPC_URL ?? "https://api.devnet.solana.com";
  const denominations = parseDenominations();

  const admin = loadKeypair(adminPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = resolve(__dirname, "../target/idl/octora_mixer.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();

  const program = new anchor.Program<OctoraMixer>(idl, provider);

  console.log("Multi-denomination mixer pool init");
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  program:    ${programId.toBase58()}`);
  console.log(`  authority:  ${admin.publicKey.toBase58()}  <-- becomes admin FOREVER for each pool`);
  console.log(`  denominations (lamports): ${denominations.map((d) => d.toString()).join(", ")}`);
  console.log();

  const balance = await connection.getBalance(admin.publicKey);
  const minLamports = Number(0.05 * anchor.web3.LAMPORTS_PER_SOL) * denominations.length;
  if (balance < minLamports) {
    console.error(
      `Admin balance too low: ${balance} lamports (need >= ${minLamports} for ${denominations.length} pool inits).`,
    );
    console.error(`Fund with: solana airdrop 1 ${admin.publicKey.toBase58()} -u ${rpcUrl}`);
    process.exit(1);
  }

  // Idempotent: skip pools that already exist, init only the missing ones.
  // Lets this script run safely on a partially-initialised cluster (e.g.
  // after a failed prior run or when a single new denom is added).
  const plan = await Promise.all(
    denominations.map(async (denom) => {
      const denomBuf = Buffer.alloc(8);
      denomBuf.writeBigUInt64LE(denom);
      const [poolPda] = PublicKey.findProgramAddressSync(
        [MIXER_POOL_SEED, denomBuf],
        programId,
      );
      const existing = await connection.getAccountInfo(poolPda);
      return { denom, poolPda, exists: existing !== null };
    }),
  );

  const toInit = plan.filter((p) => !p.exists);
  const skipped = plan.filter((p) => p.exists);

  for (const p of skipped) {
    console.log(`  SKIP ${p.denom.toString().padStart(12)} lamports — pool ${p.poolPda.toBase58()} already exists`);
  }
  for (const p of toInit) {
    console.log(`  INIT ${p.denom.toString().padStart(12)} lamports → ${p.poolPda.toBase58()}`);
  }

  if (toInit.length === 0) {
    console.log("\nAll requested pools already initialized. Nothing to do.");
    return;
  }

  console.log();
  console.log(`Press Ctrl+C in the next 5s to abort (${toInit.length} pools will be initialised)...`);
  await new Promise((r) => setTimeout(r, 5000));

  for (const p of toInit) {
    const sig = await program.methods
      .initialize(new anchor.BN(p.denom.toString()))
      .accounts({
        authority: admin.publicKey,
        mixerPool: p.poolPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`Initialized ${p.denom.toString()} lamports — tx ${sig}`);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
