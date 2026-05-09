/**
 * Devnet swap loop — runs N back-and-forth swaps on a Meteora DLMM pair to
 * generate trading fees that accrue to the LPs in the bins the swaps cross.
 *
 * Why: portfolio testing needs measurable on-chain fees so the Claim flow
 * has something to claim. Just depositing SOL doesn't accrue fees — only
 * swaps through bins where you have liquidity do.
 *
 * Usage:
 *   npx tsx scripts/devnet-swap-loop.ts
 *
 * Configuration is read from the repo-root `.env`. Required keys:
 *   LB_PAIR              Meteora DLMM pair address
 *   KEYPAIR_PATH         path to a Solana keypair JSON (e.g. ~/.config/solana/id.json)
 * Optional keys (defaults shown):
 *   ITERATIONS=5
 *   AMOUNT_LAMPORTS=1000000
 *   DIRECTION=both       xy | yx | both
 *   RPC_URL=https://api.devnet.solana.com
 *
 * Notes:
 *   - Single-sided SOL deposits only support X→Y swaps (SOL is on Y, no X
 *     above active means Y→X fails with "insufficient liquidity"). Use
 *     DIRECTION=xy in that case.
 *   - The signing wallet MUST hold the inbound token for whichever
 *     direction(s) you swap. Wrap SOL first for wSOL-paired pools
 *     (`spl-token wrap`).
 *   - Slippage is permissive (5%) since we're on devnet.
 *   - Fees accrue *only* in bins the swap crosses. If your position is
 *     out of range, run enough X→Y swaps to push the active bin down
 *     into your range, then continue.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import DLMM from "@meteora-ag/dlmm";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Auto-load the repo-root .env so `npx tsx scripts/devnet-swap-loop.ts` works
// with no CLI flags. Resolved against cwd because tsx's CJS transform leaves
// `import.meta.dirname` undefined — the script's contract is "run from the
// repo root", so cwd-based resolution is the simplest reliable path.
const ENV_FILE = resolve(process.cwd(), ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith("~")
    ? path.replace("~", process.env.HOME ?? "")
    : path;
  const raw = readFileSync(resolve(expanded), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function swapOnce(
  dlmm: DLMM,
  connection: Connection,
  user: Keypair,
  swapForY: boolean,
  inAmount: BN,
): Promise<{ signature: string; outAmount: string; fee: string }> {
  const inToken = swapForY ? dlmm.lbPair.tokenXMint : dlmm.lbPair.tokenYMint;
  const outToken = swapForY ? dlmm.lbPair.tokenYMint : dlmm.lbPair.tokenXMint;

  // Pull bin arrays around the current active bin so the quote sees enough
  // liquidity to plan the swap. 4 is generous for small ping-pong amounts.
  const binArrays = await dlmm.getBinArrayForSwap(swapForY, 4);

  const quote = dlmm.swapQuote(
    inAmount,
    swapForY,
    new BN(500), // 5% slippage in BPS
    binArrays,
    true, // allow partial fill — devnet liquidity can be thin
  );

  const tx = await dlmm.swap({
    inToken,
    outToken,
    inAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: user.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = user.publicKey;
  tx.sign(user);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return {
    signature,
    outAmount: quote.outAmount.toString(),
    fee: quote.fee.toString(),
  };
}

type Direction = "xy" | "yx" | "both";

function parseDirection(): Direction {
  const raw = (process.env.DIRECTION ?? "both").toLowerCase();
  if (raw === "xy" || raw === "yx" || raw === "both") return raw;
  throw new Error(`Invalid DIRECTION='${raw}' (expected xy | yx | both)`);
}

async function main() {
  const lbPair = new PublicKey(requireEnv("LB_PAIR"));
  const keypair = loadKeypair(requireEnv("KEYPAIR_PATH"));
  const iterations = Number(process.env.ITERATIONS ?? "5");
  const amount = new BN(process.env.AMOUNT_LAMPORTS ?? "1000000");
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const direction = parseDirection();

  const connection = new Connection(rpcUrl, "confirmed");
  let dlmm = await DLMM.create(connection, lbPair);
  const initialActive = dlmm.lbPair.activeId;

  console.log(`LB pair:        ${lbPair.toBase58()}`);
  console.log(`User:           ${keypair.publicKey.toBase58()}`);
  console.log(`Token X:        ${dlmm.lbPair.tokenXMint.toBase58()}`);
  console.log(`Token Y:        ${dlmm.lbPair.tokenYMint.toBase58()}`);
  console.log(`Active bin:     ${initialActive}`);
  console.log(`Direction:      ${direction}`);
  console.log(`Iterations:     ${iterations}`);
  console.log(`Amount/swap:    ${amount.toString()} lamports`);
  console.log("---");

  // If a direction has failed twice in a row (typically "insufficient
  // liquidity" because that side of the book is empty), stop trying it
  // for the rest of the run instead of spamming pointless retries.
  let xyFailStreak = 0;
  let yxFailStreak = 0;
  const STREAK_LIMIT = 2;

  for (let i = 0; i < iterations; i++) {
    if ((direction === "xy" || direction === "both") && xyFailStreak < STREAK_LIMIT) {
      try {
        const xy = await swapOnce(dlmm, connection, keypair, true, amount);
        console.log(
          `[${i + 1}/${iterations}] X→Y  out=${xy.outAmount} fee=${xy.fee} sig=${xy.signature}`,
        );
        xyFailStreak = 0;
      } catch (err) {
        xyFailStreak++;
        console.error(
          `[${i + 1}] X→Y failed:`,
          err instanceof Error ? err.message : err,
        );
        if (xyFailStreak >= STREAK_LIMIT) {
          console.error("  → giving up on X→Y for this run (likely no Y liquidity below active).");
        }
      }
      dlmm = await DLMM.create(connection, lbPair);
    }

    if ((direction === "yx" || direction === "both") && yxFailStreak < STREAK_LIMIT) {
      try {
        const yx = await swapOnce(dlmm, connection, keypair, false, amount);
        console.log(
          `[${i + 1}/${iterations}] Y→X  out=${yx.outAmount} fee=${yx.fee} sig=${yx.signature}`,
        );
        yxFailStreak = 0;
      } catch (err) {
        yxFailStreak++;
        console.error(
          `[${i + 1}] Y→X failed:`,
          err instanceof Error ? err.message : err,
        );
        if (yxFailStreak >= STREAK_LIMIT) {
          console.error("  → giving up on Y→X for this run (likely no X liquidity above active).");
        }
      }
      dlmm = await DLMM.create(connection, lbPair);
    }

    if (xyFailStreak >= STREAK_LIMIT && yxFailStreak >= STREAK_LIMIT) {
      console.error("Both directions failing — pool has no usable liquidity. Exiting early.");
      break;
    }
  }

  const finalActive = dlmm.lbPair.activeId;
  console.log("---");
  console.log(`Active bin: ${initialActive} → ${finalActive}`);
  console.log(
    "Done. Check your position with /executor/position-state to see feeX/feeY.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
