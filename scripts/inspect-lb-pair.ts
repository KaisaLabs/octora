/**
 * Print Meteora DLMM lb_pair status fields so you can see why a swap was
 * rejected with PoolDisabled (Anchor error 6042). Useful on devnet where
 * many pairs sit in `activation_point = u64::MAX` (deposits allowed,
 * swaps locked).
 *
 * Usage:
 *   LB_PAIR=<addr> RPC_URL=https://api.devnet.solana.com \
 *   pnpm tsx scripts/inspect-lb-pair.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";

async function main() {
  const lbPairAddr = process.env.LB_PAIR;
  if (!lbPairAddr) throw new Error("LB_PAIR env var required");
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";

  const connection = new Connection(rpcUrl, "confirmed");
  const dlmm = await DLMM.create(connection, new PublicKey(lbPairAddr));
  const p = dlmm.lbPair as unknown as Record<string, unknown>;

  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);

  console.log(`lb_pair:                ${lbPairAddr}`);
  console.log(`tokenX:                 ${dlmm.lbPair.tokenXMint.toBase58()}`);
  console.log(`tokenY:                 ${dlmm.lbPair.tokenYMint.toBase58()}`);
  console.log(`activeId:               ${dlmm.lbPair.activeId}`);
  console.log(`binStep:                ${dlmm.lbPair.binStep}`);
  console.log(`status:                 ${String(p.status)}`);
  console.log(`pairType:               ${String(p.pairType)}`);
  console.log(`activationType:         ${String(p.activationType)} (0=Slot, 1=Time)`);
  console.log(`activationPoint:        ${String(p.activationPoint)}`);
  console.log(`preActivationDuration:  ${String(p.preActivationDuration)}`);
  console.log(`preActivationSwapAddr:  ${String(p.preActivationSwapAddress)}`);
  console.log(`current slot:           ${slot}`);
  console.log(`current unix time:      ${blockTime ?? "unknown"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
