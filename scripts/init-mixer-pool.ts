import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { OctoraMixer } from "../target/types/octora_mixer";

const MIXER_POOL_SEED = Buffer.from("mixer_pool");

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

async function main() {
  const programId = new PublicKey(requireEnv("OCTORA_MIXER_PROGRAM_ID"));
  const adminPath = requireEnv("OCTORA_MIXER_ADMIN_KEYPAIR");
  const denom = new anchor.BN(process.env.MIXER_DENOMINATION ?? "1000000000");
  const rpcUrl =
    process.env.OCTORA_EXECUTOR_RPC_URL ?? "https://api.devnet.solana.com";

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

  const denomBuf = denom.toArrayLike(Buffer, "le", 8);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [MIXER_POOL_SEED, denomBuf],
    programId,
  );

  const existing = await connection.getAccountInfo(poolPda);
  if (existing) {
    console.log(`Pool already exists at ${poolPda.toBase58()}`);
    console.log(`Refusing to re-init. Inspect with:`);
    console.log(`  solana account ${poolPda.toBase58()} -u ${rpcUrl}`);
    process.exit(1);
  }

  const balance = await connection.getBalance(admin.publicKey);
  const minLamports = 0.05 * anchor.web3.LAMPORTS_PER_SOL;
  if (balance < minLamports) {
    console.error(
      `Admin balance too low: ${balance} lamports (need >= ${minLamports}).`,
    );
    console.error(`Fund with: solana airdrop 1 ${admin.publicKey.toBase58()} -u ${rpcUrl}`);
    process.exit(1);
  }

  console.log("Initializing mixer pool");
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  program:    ${programId.toBase58()}`);
  console.log(`  denom:      ${denom.toString()} lamports`);
  console.log(`  pool PDA:   ${poolPda.toBase58()}`);
  console.log(`  authority:  ${admin.publicKey.toBase58()}  <-- becomes admin FOREVER`);
  // MAINNET_BLOCKER: this authority controls `set_paused` on the pool and
  // is permanent — there is no transfer-authority instruction. On mainnet
  // it MUST be a multisig from the start. See docs/test-plan.md §14.
  console.log();
  console.log("Press Ctrl+C in the next 5s to abort...");
  await new Promise((r) => setTimeout(r, 5000));

  const sig = await program.methods
    .initialize(denom)
    .accounts({
      authority: admin.publicKey,
      mixerPool: poolPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`Initialized. Tx: ${sig}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
