import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import type { SolanaChain } from "#common/solana/chain";

/**
 * Shared context the mixer tx-builders need from `MixerService`. Built
 * once in the service constructor and passed to each builder so they
 * don't each have to re-resolve `program` / `programId` / `poolPDA` /
 * `denomination`.
 *
 * Mirrors the `executor/builders/types.ts::BuilderContext` pattern
 * established in step 4 of the SolanaChain rollout — same shape, same
 * intent.
 */
export interface MixerTxContext {
  /** Anchor program bound against the deployed mixer program id. */
  program: Program;
  /** Mixer program id (matches `program.programId`). */
  programId: PublicKey;
  /** This service instance's mixer_pool PDA (per-denomination). */
  poolPDA: PublicKey;
  /** Pool denomination in lamports. Encoded into the `initialize` ix. */
  denomination: bigint;
  /** Chain seam — used only for `getLatestBlockhash` inside the builders. */
  chain: SolanaChain;
}
