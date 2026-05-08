/**
 * Stamp `activationPoint = now + <seconds>` into the DLMM config(s) right
 * before running `dlmm-create-pool`. This gives you a short pre-activation
 * window where seeding actions (which require a NOT-YET-activated pool)
 * still work, but the pool flips to swap-enabled minutes later so you can
 * run the swap loop and accrue fees.
 *
 * Usage:
 *   npx tsx scripts/set-pool-activation-in.ts [seconds]      # default 300 (5 min)
 *
 * Workflow:
 *   1. npx tsx scripts/set-pool-activation-in.ts 300
 *   2. (in meteora-invent/studio)  pnpm dlmm-create-pool
 *   3. (in meteora-invent/studio)  pnpm dlmm-seed-liquidity-single-bin
 *   4. wait until the activation timestamp passes (script prints it)
 *   5. npx tsx scripts/devnet-swap-loop.ts  # generates fees
 *
 * Notes:
 *   - Updates BOTH dlmm_config.jsonc copies (root + meteora-invent/studio/config)
 *     so they stay in sync.
 *   - Honours `activationType`: 0 = slot (queries current slot from RPC),
 *     1 = unix timestamp.
 *   - Comments in the JSONC are preserved — we do a regex replace on the
 *     `"activationPoint": ...,` line, not a JSON.parse roundtrip.
 */

import { Connection } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATHS = [
  resolve(__dirname, "..", "dlmm_config.jsonc"),
  resolve(__dirname, "..", "meteora-invent", "studio", "config", "dlmm_config.jsonc"),
];

function readActivationType(jsonc: string): number {
  const m = jsonc.match(/"activationType"\s*:\s*(\d+)/);
  if (!m) throw new Error("Could not find activationType in config");
  return Number(m[1]);
}

function replaceActivationPoint(jsonc: string, value: number): string {
  // Match the existing line (numeric value OR null) and replace it with our
  // freshly computed value. Trailing comma preserved; comments untouched.
  const re = /("activationPoint"\s*:\s*)(\d+|null)(\s*,?)/;
  if (!re.test(jsonc)) {
    throw new Error("Could not find activationPoint line in config");
  }
  return jsonc.replace(re, `$1${value}$3`);
}

async function main() {
  const offsetSeconds = Number(process.argv[2] ?? "300");
  if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
    throw new Error(`Invalid offset seconds: ${process.argv[2]}`);
  }

  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  // Pull both files first so we fail fast if either is missing/malformed.
  const files = CONFIG_PATHS.map((p) => ({ path: p, content: readFileSync(p, "utf8") }));
  const activationType = readActivationType(files[0].content);

  let value: number;
  let humanReadable: string;

  if (activationType === 1) {
    // Unix timestamp in seconds.
    const nowSec = Math.floor(Date.now() / 1000);
    value = nowSec + offsetSeconds;
    humanReadable = new Date(value * 1000).toISOString();
  } else if (activationType === 0) {
    // Slot. Devnet/mainnet ≈ 2.5 slots/sec; we round up to be safe.
    const currentSlot = await connection.getSlot("confirmed");
    value = currentSlot + Math.ceil(offsetSeconds * 2.5);
    humanReadable = `slot ${value} (≈ +${offsetSeconds}s from current slot ${currentSlot})`;
  } else {
    throw new Error(`Unsupported activationType: ${activationType}`);
  }

  for (const f of files) {
    const updated = replaceActivationPoint(f.content, value);
    writeFileSync(f.path, updated, "utf8");
    console.log(`✓ updated ${f.path}`);
  }

  console.log("---");
  console.log(`activationType : ${activationType} (${activationType === 1 ? "Timestamp" : "Slot"})`);
  console.log(`activationPoint: ${value}`);
  console.log(`activates at   : ${humanReadable}`);
  console.log(`offset         : +${offsetSeconds}s`);
  console.log("");
  console.log("Next: run dlmm-create-pool, then any seeding action, then wait until the activation");
  console.log("point passes before running the swap loop.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
