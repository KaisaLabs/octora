/**
 * Initialise a fresh Meteora DLMM pair on a local surfpool node.
 *
 * Surfpool forks mainnet just-in-time, so the DLMM program, the WSOL/USDC
 * mints, and any preset-parameter accounts are auto-cloned the first time
 * this tx references them. The pair itself is brand-new and lives only on
 * surfpool — restarting surfpool wipes it.
 *
 * Usage:
 *   pnpm tsx scripts/init-dlmm-pool-surfpool.ts
 *
 * Configuration is read from the repo-root `.env`.
 *
 * Required:
 *   KEYPAIR_PATH                 path to creator/funder keypair JSON
 *
 * Optional (defaults shown):
 *   RPC_URL=http://127.0.0.1:8899
 *   TOKEN_X_MINT=So11111111111111111111111111111111111111112   (WSOL)
 *   TOKEN_Y_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   (USDC)
 *   BIN_STEP=25                  bps per bin (0.25%)
 *   BASE_FEE_BPS=100             1% base fee
 *   ACTIVE_ID=0                  initial active bin (price = (1 + binStep/1e4)^id)
 *   ACTIVATION_POINT=0           0 = activate immediately
 *   FUND_BALANCES=1              if "1", airdrop SOL + cheatcode WSOL/USDC into KEYPAIR_PATH
 *   FUND_AMOUNT_X=1000000000     X token amount to credit when FUND_BALANCES=1
 *   FUND_AMOUNT_Y=1000000000     Y token amount to credit when FUND_BALANCES=1
 */

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import DLMM, { ActivationType } from "@meteora-ag/dlmm";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_FILE = resolve(process.cwd(), ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith("~") ? path.replace("~", process.env.HOME ?? "") : path;
  const raw = readFileSync(resolve(expanded), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = (await res.json()) as { error?: { message: string }; result?: unknown };
  if (body.error) throw new Error(`${method} RPC error: ${body.error.message}`);
  return body.result;
}

async function fundCreator(
  rpcUrl: string,
  owner: PublicKey,
  mintX: PublicKey,
  mintY: PublicKey,
  amountX: bigint,
  amountY: bigint,
): Promise<void> {
  // Cheatcodes only work against surfpool. Fail fast if pointed elsewhere.
  if (!/127\.0\.0\.1|localhost/.test(rpcUrl)) {
    throw new Error(`FUND_BALANCES=1 requires a surfpool RPC, got ${rpcUrl}`);
  }
  // surfpool deserializes `amount` as JSON u64 — must be a number, not a
  // string. Numbers above 2^53 lose precision in JSON; throw rather than
  // silently truncate.
  const toJsonU64 = (v: bigint): number => {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Amount ${v} exceeds JS safe integer; split or fund via setAccount instead.`);
    }
    return Number(v);
  };
  await rpcCall(rpcUrl, "requestAirdrop", [owner.toBase58(), 10_000_000_000]);
  await rpcCall(rpcUrl, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mintX.toBase58(),
    { amount: toJsonU64(amountX) },
  ]);
  await rpcCall(rpcUrl, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mintY.toBase58(),
    { amount: toJsonU64(amountY) },
  ]);
  console.log(`Funded ${owner.toBase58()}: 10 SOL, ${amountX} of X, ${amountY} of Y`);
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const creator = loadKeypair(requireEnv("KEYPAIR_PATH"));
  const tokenX = new PublicKey(
    process.env.TOKEN_X_MINT ?? "So11111111111111111111111111111111111111112",
  );
  const tokenY = new PublicKey(
    process.env.TOKEN_Y_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const binStep = new BN(process.env.BIN_STEP ?? "25");
  const baseFeeBps = new BN(process.env.BASE_FEE_BPS ?? "100");
  const activeId = new BN(process.env.ACTIVE_ID ?? "0");
  const activationPoint = new BN(process.env.ACTIVATION_POINT ?? "0");
  const shouldFund = process.env.FUND_BALANCES === "1";

  if (!/127\.0\.0\.1|localhost/.test(rpcUrl)) {
    console.warn(`⚠  RPC_URL=${rpcUrl} does not look like surfpool. Continue at your own risk.`);
  }

  const connection = new Connection(rpcUrl, "confirmed");

  if (shouldFund) {
    await fundCreator(
      rpcUrl,
      creator.publicKey,
      tokenX,
      tokenY,
      BigInt(process.env.FUND_AMOUNT_X ?? "1000000000"),
      BigInt(process.env.FUND_AMOUNT_Y ?? "1000000000"),
    );
  }

  // Surfaces "DLMM program not found on this RPC" before we burn time
  // building the tx. JIT-fetch on first reference would also work, but the
  // error here is far clearer than a downstream account-not-found.
  const programInfo = await connection.getAccountInfo(
    new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  );
  if (!programInfo) {
    console.warn(
      "DLMM program not yet on surfpool — pre-clone with surfnet_cloneProgramAccount or just let JIT pull it.",
    );
  }

  // Customizable-permissionless pairs are PDA'd from (tokenX, tokenY) alone —
  // exactly one can exist per mint pair. On surfpool the mainnet pair gets
  // JIT-cloned the moment DLMM probes for it, so a fresh init collides with
  // SystemProgram error 0x0 (AccountAlreadyInUse). Detect up front so we can
  // print the existing address instead of burning a simulation.
  const existing = await DLMM.getCustomizablePermissionlessLbPairIfExists(
    connection,
    tokenX,
    tokenY,
  ).catch(() => null);
  if (existing) {
    console.log(`\n✓ LB pair already exists for these mints: ${existing.toBase58()}`);
    console.log(`  (Surfpool JIT-cloned it from mainnet, or a previous run created it.)`);
    console.log(`\nReuse it:`);
    console.log(`  echo "LB_PAIR=${existing.toBase58()}" >> .env`);
    console.log(`\nOr force a fresh init by:`);
    console.log(`  • picking different mints (TOKEN_X_MINT/TOKEN_Y_MINT), or`);
    console.log(`  • zeroing the existing PDA with surfnet_setAccount (destructive).`);
    return;
  }

  const tx: Transaction = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    binStep,
    tokenX,
    tokenY,
    activeId,
    baseFeeBps,
    ActivationType.Timestamp,
    false, // hasAlphaVault
    creator.publicKey,
    activationPoint,
    false, // creatorPoolOnOffControl
  );

  console.log("Submitting createCustomizablePermissionlessLbPair2");
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  tokenX:     ${tokenX.toBase58()}`);
  console.log(`  tokenY:     ${tokenY.toBase58()}`);
  console.log(`  binStep:    ${binStep.toString()} bps`);
  console.log(`  baseFee:    ${baseFeeBps.toString()} bps`);
  console.log(`  activeId:   ${activeId.toString()}`);
  console.log(`  activate:   ${activationPoint.toString()} (0=immediate)`);
  console.log(`  creator:    ${creator.publicKey.toBase58()}`);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator.publicKey;
  tx.sign(creator);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  console.log(`\nInit tx: ${signature}`);

  const pairAddr = await DLMM.getCustomizablePermissionlessLbPairIfExists(
    connection,
    tokenX,
    tokenY,
  ).catch(() => null);

  if (pairAddr) {
    console.log(`\n✓ LB pair created: ${pairAddr.toBase58()}`);
    console.log(`\nNext steps:`);
    console.log(`  echo "LB_PAIR=${pairAddr.toBase58()}" >> .env`);
    console.log(`  pnpm tsx scripts/devnet-swap-loop.ts   # works against surfpool too`);
  } else {
    console.log("Pair created but pubkey lookup failed — check Surfpool Studio at http://localhost:18488");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
