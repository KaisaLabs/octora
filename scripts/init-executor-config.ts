/**
 * One-shot bootstrap: creates the executor's singleton `Config` PDA on
 * whichever cluster `ANCHOR_PROVIDER_URL` points at. Idempotent — bails
 * early if the PDA already exists.
 *
 * Required on every fresh cluster before any DLMM instruction will work
 * (init_position / add_liquidity / claim_fees / withdraw_close / swap all
 * read `Config` to check the pause flag — uninitialized → AnchorError
 * 3012 / 0xbc4 AccountNotInitialized).
 *
 * Prerequisites:
 *   - Executor program deployed to the target cluster.
 *   - On non-mainnet, deployed binary must be built with
 *     `--features permissionless-init` (else signer must equal
 *     EXECUTOR_ADMIN_AUTHORITY in programs/octora-executor/src/constants.rs).
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/init-executor-config.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";

const EXECUTOR_PROGRAM_ID = new PublicKey(
  "4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK",
);
const CONFIG_SEED = Buffer.from("config");

function anchorDiscriminator(ix: string): Buffer {
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const authority = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    EXECUTOR_PROGRAM_ID,
  );

  console.log("Cluster RPC :", conn.rpcEndpoint);
  console.log("Executor ID :", EXECUTOR_PROGRAM_ID.toBase58());
  console.log("Config PDA  :", configPda.toBase58());
  console.log("Authority   :", authority.toBase58());

  const existing = await conn.getAccountInfo(configPda);
  if (existing) {
    console.log("Config PDA already initialized — nothing to do.");
    return;
  }

  const balance = await conn.getBalance(authority);
  if (balance === 0) {
    throw new Error(
      `Authority ${authority.toBase58()} has 0 SOL on ${conn.rpcEndpoint} — fund it before retrying.`,
    );
  }

  const ix = new TransactionInstruction({
    programId: EXECUTOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("init_config"),
  });

  const sig = await provider.sendAndConfirm(new Transaction().add(ix));
  console.log("init_config tx:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
