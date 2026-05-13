import type { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { DlmmProgramConstants } from "#common/solana/dlmm-program";

/**
 * Shared context the builders need from the orchestrator. Built once in
 * `ExecutorService` and threaded through each builder so they don't each
 * have to re-resolve config / IDL / provider state.
 */
export interface BuilderContext {
  connection: Connection;
  relayer: Keypair;
  /** Octora executor program id (NOT the DLMM program id). */
  executorProgramId: PublicKey;
  program: Program;
  provider: AnchorProvider;
  dlmm: DlmmProgramConstants;
}

export interface TestPairConfig {
  tokenX: string;
  tokenY: string;
  lbPair: string;
  binArrayLower: string;
  binArrayUpper: string;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  activeBin: number;
  binStep: number;
  baseFactor: number;
}
