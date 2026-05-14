/**
 * Fresh-localnet bootstrap for surfpool.
 *
 * Merges the per-step scripts that used to be run by hand:
 *   1. requestAirdrop      — fund admin so subsequent txs can pay rent
 *   2. init_config         — executor singleton Config PDA (init-executor-config.ts)
 *   3. mixer_pool init     — one pool per denomination          (init-mixer-pools.ts)
 *   4. fund relayer wallets — top up executor + mixer relayer hot wallets
 *
 * All steps are idempotent: re-running on a partially-initialised
 * cluster (e.g. after a failed earlier run, or after adding a new denom)
 * skips the pieces that are already in place and only touches what's missing.
 *
 * Surfpool is assumed but not required. If RPC_URL points elsewhere we warn
 * but proceed — `requestAirdrop` works on any test validator too.
 *
 * Prerequisites:
 *   - surfpool running                (default: http://127.0.0.1:8899)
 *   - octora_executor + octora_mixer  deployed to that RPC
 *   - executor binary built with `--features permissionless-init` for any
 *     non-mainnet cluster (else init_config requires EXECUTOR_ADMIN_AUTHORITY)
 *
 * Required env:
 *   OCTORA_MIXER_ADMIN_KEYPAIR    path to admin keypair JSON (also signs init_config)
 *
 * Optional env (defaults shown):
 *   RPC_URL=http://127.0.0.1:8899
 *   OCTORA_EXECUTOR_PROGRAM_ID=4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK
 *   OCTORA_MIXER_PROGRAM_ID=BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx
 *   MIXER_DENOMINATIONS=100000000,1000000000,10000000000   (lamports, csv)
 *   AIRDROP_SOL=10
 *   RELAYER_FUND_SOL=5                      target balance per relayer
 *   OCTORA_EXECUTOR_RELAYER_KEYPAIR=...     path / file:<path> / inline JSON array
 *   OCTORA_MIXER_RELAYER_HOT_WALLET=...     path / file:<path> / inline JSON array
 *   SKIP_AIRDROP=0    SKIP_EXECUTOR=0    SKIP_MIXER=0    SKIP_RELAYERS=0
 *
 * Run:
 *   pnpm tsx scripts/init-surfpool.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OctoraMixer } from "../target/types/octora_mixer";

// Node's process.loadEnvFile will not overwrite vars that are already set in
// process.env — including ones inherited as empty strings from a parent
// shell (e.g. a wrapper that forwarded `VAR="${VAR:-}"`). Strip those
// empties first so .env can populate them.
for (const k of [
  "OCTORA_EXECUTOR_RELAYER_KEYPAIR",
  "OCTORA_MIXER_RELAYER_HOT_WALLET",
  "OCTORA_MIXER_ADMIN_KEYPAIR",
  "MIXER_DENOMINATIONS",
  "RPC_URL",
  "RELAYER_FUND_SOL",
  "AIRDROP_SOL",
]) {
  if (process.env[k] !== undefined && process.env[k]!.trim() === "") {
    delete process.env[k];
  }
}

const ENV_FILE = resolve(process.cwd(), ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const DEFAULT_EXECUTOR_PROGRAM_ID = "4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK";
const DEFAULT_MIXER_PROGRAM_ID = "BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx";
const DEFAULT_RPC_URL = "http://127.0.0.1:8899";

// Matches MIXER_DENOMINATIONS default in octora-api/src/common/config.ts:
// 0.1, 1, 10 SOL. Keep these in sync with init-mixer-pools.ts.
const DEFAULT_DENOMINATIONS: bigint[] = [
  100_000_000n,
  1_000_000_000n,
  10_000_000_000n,
];

const CONFIG_SEED = Buffer.from("config");
const MIXER_POOL_SEED = Buffer.from("mixer_pool");

// Mirrors `ADMIN_AUTHORITY` in programs/octora-mixer/src/constants.rs.
// Used only for a pre-flight check so we can fail fast with an actionable
// message instead of letting the Anchor RPC return AnchorError 6010
// (Unauthorized) deep inside `initialize`.
//
// Keep these bytes in sync with the Rust constant. Mismatch is fine on
// localnet IF the deployed mixer was built with `--features
// permissionless-init` (the address constraint is dropped).
const MIXER_ADMIN_AUTHORITY = new PublicKey(
  Uint8Array.from([
    0xef, 0x1b, 0x67, 0x63, 0x59, 0xfc, 0x9f, 0x9f, 0x09, 0x4f, 0x1c, 0xe1,
    0x83, 0x8b, 0xb1, 0xd5, 0x8f, 0x39, 0x5c, 0xb6, 0x65, 0xfe, 0xc5, 0x6f,
    0x27, 0xe3, 0x12, 0x33, 0x5c, 0xfb, 0x4f, 0xca,
  ]),
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith("~")
    ? path.replace("~", process.env.HOME ?? "")
    : path;
  const raw = readFileSync(resolve(expanded), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

// Accepts the same forms the API config accepts:
//   - inline JSON array: "[12,34,...]"
//   - file:<absolute-or-relative-path>
//   - bare path (with optional leading ~)
function loadKeypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  const path = trimmed.startsWith("file:") ? trimmed.slice("file:".length) : trimmed;
  return loadKeypair(path);
}

async function fundWallet(
  connection: Connection,
  label: string,
  target: PublicKey,
  targetSol: number,
): Promise<void> {
  const targetLamports = targetSol * LAMPORTS_PER_SOL;
  const current = await connection.getBalance(target);
  if (current >= targetLamports) {
    console.log(
      `  ${label}: ${target.toBase58()} balance ${(current / LAMPORTS_PER_SOL).toFixed(3)} SOL (>= ${targetSol}) — skip`,
    );
    return;
  }
  const need = targetLamports - current;
  console.log(
    `  ${label}: ${target.toBase58()} balance ${(current / LAMPORTS_PER_SOL).toFixed(3)} SOL — airdropping ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`,
  );
  const sig = await connection.requestAirdrop(target, need);
  await connection.confirmTransaction(sig, "confirmed");
  const after = await connection.getBalance(target);
  console.log(`  ${label}: balance ${(after / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
}

async function fundRelayers(
  connection: Connection,
  adminPubkey: PublicKey,
  targetSol: number,
): Promise<void> {
  const sources: { label: string; envVar: string; secret: string | undefined }[] = [
    {
      label: "executor relayer",
      envVar: "OCTORA_EXECUTOR_RELAYER_KEYPAIR",
      secret: process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR,
    },
    {
      label: "mixer relayer ",
      envVar: "OCTORA_MIXER_RELAYER_HOT_WALLET",
      secret: process.env.OCTORA_MIXER_RELAYER_HOT_WALLET,
    },
  ];

  const seen = new Set<string>([adminPubkey.toBase58()]);
  let funded = 0;
  for (const s of sources) {
    if (!s.secret || s.secret.trim() === "") {
      console.log(`  ${s.label}: ${s.envVar} unset — skip`);
      continue;
    }
    let kp: Keypair;
    try {
      kp = loadKeypairFromSecret(s.secret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  ${s.label}: failed to load (${s.envVar}): ${msg} — skip`);
      continue;
    }
    const b58 = kp.publicKey.toBase58();
    if (seen.has(b58)) {
      console.log(`  ${s.label}: ${b58} same as a prior wallet — skip`);
      continue;
    }
    seen.add(b58);
    await fundWallet(connection, s.label, kp.publicKey, targetSol);
    funded++;
  }
  if (funded === 0) {
    console.log("  no relayer wallets funded");
  }
}

function anchorDiscriminator(ix: string): Buffer {
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}

function parseDenominations(): bigint[] {
  const raw = process.env.MIXER_DENOMINATIONS?.trim();
  if (!raw) return DEFAULT_DENOMINATIONS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
  return parsed.length === 0 ? DEFAULT_DENOMINATIONS : parsed;
}

async function ensureAirdrop(
  connection: Connection,
  authority: PublicKey,
  targetSol: number,
): Promise<void> {
  const targetLamports = targetSol * LAMPORTS_PER_SOL;
  const current = await connection.getBalance(authority);
  if (current >= targetLamports) {
    console.log(
      `  balance: ${(current / LAMPORTS_PER_SOL).toFixed(3)} SOL (>= ${targetSol}) — skip airdrop`,
    );
    return;
  }
  const need = targetLamports - current;
  console.log(
    `  balance: ${(current / LAMPORTS_PER_SOL).toFixed(3)} SOL — airdropping ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`,
  );
  const sig = await connection.requestAirdrop(authority, need);
  await connection.confirmTransaction(sig, "confirmed");
  const after = await connection.getBalance(authority);
  console.log(`  balance: ${(after / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
}

async function initExecutorConfig(
  connection: Connection,
  payer: Keypair,
  programId: PublicKey,
): Promise<void> {
  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    programId,
  );
  console.log(`  config PDA: ${configPda.toBase58()}`);

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("  already initialized — skip");
    return;
  }

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("init_config"),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log(`  init_config tx: ${sig}`);
}

async function initMixerPools(
  connection: Connection,
  admin: Keypair,
  programId: PublicKey,
  denominations: bigint[],
): Promise<void> {
  // Pre-flight: if any pool needs initialising and the signer is not the
  // baked-in ADMIN_AUTHORITY, the on-chain `address = ADMIN_AUTHORITY`
  // constraint will reject the tx with AnchorError 6010 (Unauthorized).
  // We can't introspect whether the deployed .so was built with
  // `permissionless-init`, so emit a clear, actionable error up-front.
  if (!admin.publicKey.equals(MIXER_ADMIN_AUTHORITY)) {
    const anyMissing = await (async () => {
      for (const denom of denominations) {
        const denomBuf = Buffer.alloc(8);
        denomBuf.writeBigUInt64LE(denom);
        const [poolPda] = PublicKey.findProgramAddressSync(
          [MIXER_POOL_SEED, denomBuf],
          programId,
        );
        if (!(await connection.getAccountInfo(poolPda))) return true;
      }
      return false;
    })();
    if (anyMissing) {
      console.warn(
        `!  signer ${admin.publicKey.toBase58()} != mixer ADMIN_AUTHORITY ${MIXER_ADMIN_AUTHORITY.toBase58()}.\n` +
          `   If the deployed mixer was built without --features permissionless-init,\n` +
          `   initialize will fail with AnchorError 6010 (Unauthorized).\n` +
          `   Fixes:\n` +
          `     a) Rebuild + redeploy mixer with the feature:\n` +
          `          anchor build -p octora_mixer -- --features permissionless-init\n` +
          `          solana program deploy target/deploy/octora_mixer.so \\\n` +
          `            --program-id target/deploy/octora_mixer-keypair.json --url <rpc>\n` +
          `     b) Or sign with the ADMIN_AUTHORITY keypair (set OCTORA_MIXER_ADMIN_KEYPAIR).\n`,
      );
    }
  }

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = resolve(__dirname, "../target/idl/octora_mixer.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();
  const program = new anchor.Program<OctoraMixer>(idl, provider);

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

  for (const p of plan) {
    const tag = p.exists ? "SKIP" : "INIT";
    console.log(
      `  ${tag} ${p.denom.toString().padStart(12)} lamports → ${p.poolPda.toBase58()}`,
    );
  }

  const toInit = plan.filter((p) => !p.exists);
  if (toInit.length === 0) {
    console.log("  all pools already initialized");
    return;
  }

  for (const p of toInit) {
    try {
      const sig = await program.methods
        .initialize(new anchor.BN(p.denom.toString()))
        .accounts({
          authority: admin.publicKey,
          mixerPool: p.poolPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  initialized ${p.denom.toString()} — tx ${sig}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unauthorized") || msg.includes("6010")) {
        throw new Error(
          `mixer initialize rejected: signer ${admin.publicKey.toBase58()} is not the baked-in ADMIN_AUTHORITY ` +
            `(${MIXER_ADMIN_AUTHORITY.toBase58()}).\n` +
            `Rebuild mixer with permissionless-init for localnet:\n` +
            `  anchor build -p octora_mixer -- --features permissionless-init\n` +
            `  solana program deploy target/deploy/octora_mixer.so \\\n` +
            `    --program-id target/deploy/octora_mixer-keypair.json --url ${connection.rpcEndpoint}\n` +
            `Then re-run this script.`,
        );
      }
      throw e;
    }
  }
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const executorProgramId = new PublicKey(
    process.env.OCTORA_EXECUTOR_PROGRAM_ID ?? DEFAULT_EXECUTOR_PROGRAM_ID,
  );
  const mixerProgramId = new PublicKey(
    process.env.OCTORA_MIXER_PROGRAM_ID ?? DEFAULT_MIXER_PROGRAM_ID,
  );
  const adminPath = requireEnv("OCTORA_MIXER_ADMIN_KEYPAIR");
  const admin = loadKeypair(adminPath);
  const denominations = parseDenominations();
  const airdropSol = Number(process.env.AIRDROP_SOL ?? "10");

  if (!/127\.0\.0\.1|localhost/.test(rpcUrl)) {
    console.warn(
      `!  RPC_URL=${rpcUrl} does not look like surfpool/localnet. Continuing.`,
    );
  }

  const connection = new Connection(rpcUrl, "confirmed");

  // Sanity-check both programs are deployed before we burn time on PDAs.
  for (const [name, pid] of [
    ["executor", executorProgramId],
    ["mixer", mixerProgramId],
  ] as const) {
    const info = await connection.getAccountInfo(pid);
    if (!info || !info.executable) {
      throw new Error(
        `${name} program ${pid.toBase58()} is not deployed on ${rpcUrl}. ` +
          `Deploy first (anchor deploy or solana program deploy).`,
      );
    }
  }

  console.log("Surfpool localnet bootstrap");
  console.log(`  rpc        : ${rpcUrl}`);
  console.log(`  admin      : ${admin.publicKey.toBase58()}`);
  console.log(`  executor   : ${executorProgramId.toBase58()}`);
  console.log(`  mixer      : ${mixerProgramId.toBase58()}`);
  console.log(
    `  denoms     : ${denominations.map((d) => d.toString()).join(", ")} lamports`,
  );
  console.log();

  if (envFlag("SKIP_AIRDROP")) {
    console.log("[1/4] airdrop — skipped (SKIP_AIRDROP=1)");
  } else {
    console.log(`[1/4] airdrop  (target ${airdropSol} SOL)`);
    await ensureAirdrop(connection, admin.publicKey, airdropSol);
  }

  if (envFlag("SKIP_EXECUTOR")) {
    console.log("\n[2/4] executor init_config — skipped (SKIP_EXECUTOR=1)");
  } else {
    console.log("\n[2/4] executor init_config");
    await initExecutorConfig(connection, admin, executorProgramId);
  }

  if (envFlag("SKIP_MIXER")) {
    console.log("\n[3/4] mixer pool init — skipped (SKIP_MIXER=1)");
  } else {
    console.log("\n[3/4] mixer pool init");
    await initMixerPools(connection, admin, mixerProgramId, denominations);
  }

  const relayerFundSol = Number(process.env.RELAYER_FUND_SOL ?? "5");
  if (envFlag("SKIP_RELAYERS")) {
    console.log("\n[4/4] fund relayers — skipped (SKIP_RELAYERS=1)");
  } else {
    console.log(`\n[4/4] fund relayers (target ${relayerFundSol} SOL each)`);
    await fundRelayers(connection, admin.publicKey, relayerFundSol);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
