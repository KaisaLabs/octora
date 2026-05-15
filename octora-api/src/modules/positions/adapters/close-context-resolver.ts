/**
 * production-ix-wiring/02 — per-position close-context resolver.
 *
 * Implementation choice (Option B per ticket). The ticket offered two
 * seams: widen `PositionRow` + run a Prisma migration (Option A), or
 * ship a `CloseContextResolver` service that either reads chain state
 * on demand or holds an in-process registry (Option B). This module is
 * Option B because it lets the resolver seam land *now* — closing
 * every `*WiringIncompleteError` 503 — with zero schema risk and zero
 * migration ordering coupled to the orchestrator deploy. A schema
 * migration can replace the in-memory store later without touching the
 * adapter signatures.
 *
 * The in-memory store surfaces `MissingPositionContextError` (503 via
 * `UpstreamError`) when a position isn't registered, instead of
 * fabricating numbers. Production wiring that needs persistent context
 * across restarts hydrates the registry from the indexer at boot —
 * out of scope for this ticket; the seam is the deliverable.
 */
import type { AccountMeta, Keypair, PublicKey } from "@solana/web3.js";

import { UpstreamError } from "#common/errors";

import type { CloseOrchestrationPositionContext } from "./production-close.adapter";
import type { CloseQuotePositionContext } from "./production-close-quote.adapter";

export interface CloseContextEntry {
  stealthKeypair: Keypair;
  positionPubkey: PublicKey;
  lbPair: PublicKey;
  fromBinId: number;
  toBinId: number;
  withdrawCloseRemainingAccounts: AccountMeta[];
  swapRemainingAccounts?: AccountMeta[];
  remainingAccountsInfo: Buffer;
  denominationLamports: bigint;
  remixCommitment: bigint;
  stealthOtherAta: PublicKey | null;
  /** Quote-side view fields (denomination is read from the entry's lamports). */
  quote: Omit<CloseQuotePositionContext, "denomination">;
}

export class MissingPositionContextError extends UpstreamError {
  constructor(positionId: string) {
    super(
      `No close-context registered for position ${positionId}. ` +
        "Production hydration writes one entry per active position; tests register fixtures via `register`.",
      { statusCode: 503, code: "close_context_missing" },
    );
    this.name = "MissingPositionContextError";
  }
}

export interface CloseContextResolverService {
  resolveOrchestration(positionId: string): Promise<CloseOrchestrationPositionContext>;
  resolveQuote(positionId: string): Promise<CloseQuotePositionContext>;
  resolveEntry(positionId: string): Promise<CloseContextEntry>;
  register(positionId: string, entry: CloseContextEntry): void;
  clear(): void;
}

export function createInMemoryCloseContextResolver(): CloseContextResolverService {
  const entries = new Map<string, CloseContextEntry>();
  function lookup(positionId: string): CloseContextEntry {
    const entry = entries.get(positionId);
    if (!entry) throw new MissingPositionContextError(positionId);
    return entry;
  }
  return {
    async resolveOrchestration(positionId) {
      const e = lookup(positionId);
      return {
        stealthKeypair: e.stealthKeypair,
        positionPubkey: e.positionPubkey,
        lbPair: e.lbPair,
        withdrawCloseRemainingAccounts: e.withdrawCloseRemainingAccounts,
        swapRemainingAccounts: e.swapRemainingAccounts,
        fromBinId: e.fromBinId,
        toBinId: e.toBinId,
        remainingAccountsInfo: e.remainingAccountsInfo,
        denomination: e.denominationLamports,
        remixCommitment: e.remixCommitment,
        stealthOtherAta: e.stealthOtherAta,
      };
    },
    async resolveQuote(positionId) {
      const e = lookup(positionId);
      return { ...e.quote, denomination: e.denominationLamports };
    },
    async resolveEntry(positionId) {
      return lookup(positionId);
    },
    register(positionId, entry) {
      entries.set(positionId, entry);
    },
    clear() {
      entries.clear();
    },
  };
}
