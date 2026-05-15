/**
 * Production `CloseOrchestrationAdapter` for the Private Position Close
 * orchestrator (close/01, Flow 3).
 *
 * Wires the relayer-signed three-tx mainline (`dlmm_withdraw_close`,
 * `dlmm_swap`, `mixer.deposit`) into the live Executor + Mixer clients.
 * The orchestrator state machine in `position.close.service.ts` is
 * unchanged; this adapter is pure plumbing that converts the per-leg
 * "submit + await confirmation" contract into real on-chain ix
 * submissions.
 *
 * Per-position context. The executor's DLMM ixs require:
 *   - the Stealth Wallet keypair (signer on the inner DLMM ix)
 *   - the lb_pair pubkey (locked at deposit time)
 *   - the position pubkey (for the close ix)
 *   - lower/upper bin IDs (for the withdraw range)
 *   - the live DLMM remaining-accounts array (16+ entries, derived from
 *     the active pool state via the Meteora SDK)
 *
 * None of that lives on the `PositionRow` today. Until a future ticket
 * persists those fields (or threads a Pod-style context object through
 * `createPositionService`), each method here throws
 * `CloseOrchestrationWiringIncompleteError` so production deployments
 * surface a clear 503-equivalent at the route layer rather than
 * silently inventing numbers. Same precedent
 * `OnchainMeteoraExecutor.requireOnchainCtx` set for the deposit-LP
 * adapter; both will be fully threaded when the Position aggregate
 * grows a stealth-context resolver.
 *
 * The class is intentionally constructible without per-position context
 * so `createApp` can instantiate it at boot. Per-call context plugs in
 * through the `contextResolver` injection point once that lands.
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";

/** SPL token account `amount` field offset (mint:32 + owner:32 = 64). */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

import { UpstreamError } from "#common/errors";
import type { SolanaChain } from "#common/solana/chain";
import type { OctoraExecutorClient } from "#modules/execution/clients";
import { MixerService } from "#modules/mixer/mixer.service";

import type { CloseOrchestrationAdapter } from "../position.close.service";

/**
 * The per-position context the production close adapter needs to build
 * real ixs. Sourced by the orchestrator from a resolver (TBD) so the
 * adapter itself stays a stateless dependency.
 */
export interface CloseOrchestrationPositionContext {
  stealthKeypair: Keypair;
  positionPubkey: PublicKey;
  lbPair: PublicKey;
  /** DLMM remaining-accounts for `dlmm_withdraw_close` (17+ entries). */
  withdrawCloseRemainingAccounts: AccountMeta[];
  /** DLMM remaining-accounts for `dlmm_swap` (17+ entries) when applicable. */
  swapRemainingAccounts?: AccountMeta[];
  /** Inclusive bin range the position covers. */
  fromBinId: number;
  toBinId: number;
  /**
   * Borsh-encoded `RemainingAccountsInfo` tail for Token-2022 transfer
   * hooks. Empty `[0,0,0,0]` when none.
   */
  remainingAccountsInfo: Buffer;
  /**
   * Mixer Pool denomination this position originally used. The re-mix
   * step deposits one denomination into the same-denom pool per ADR-0003.
   */
  denomination: bigint;
  /** Fresh commitment for the re-mix deposit (browser-generated). */
  remixCommitment: bigint;
  /**
   * Stealth wallet's ATA for the *other-side* (non-SOL) mint of the
   * pool. `null` when the pool is single-sided SOL — the adapter then
   * reports `otherSideResidualLamports = 0n` without an RPC read.
   * production-ix-wiring/02.
   */
  stealthOtherAta?: PublicKey | null;
}

export type CloseContextResolver = (positionId: string) => Promise<CloseOrchestrationPositionContext>;

export class CloseOrchestrationWiringIncompleteError extends UpstreamError {
  constructor(leg: string, missing: string) {
    super(
      `Production CloseOrchestrationAdapter cannot run ${leg}: missing ${missing}. ` +
        `Wire a contextResolver into createProductionCloseAdapter or fall back to the in-memory adapter for tests.`,
      { statusCode: 503, code: "close_adapter_wiring_incomplete" },
    );
    this.name = "CloseOrchestrationWiringIncompleteError";
  }
}

export interface ProductionCloseAdapterDeps {
  executorClient: OctoraExecutorClient;
  /** Resolved per-denomination at call time so multiple Mixer Pools work. */
  mixerServiceFor: (denomination: bigint) => MixerService;
  /**
   * Per-position context resolver. Optional at construct time so
   * `createApp` can wire the adapter even before the resolver lands;
   * each method throws `CloseOrchestrationWiringIncompleteError` until
   * a resolver is supplied.
   */
  contextResolver?: CloseContextResolver;
  /** Used for confirmation reads when the executor's `sendIx` is used directly. */
  chain: SolanaChain;
  /**
   * Optional override of how the swap leg computes
   * `min_amount_out`. The default uses the formula
   * `expectedOutLamports * (1 - slippageBps / 10000)`. Override useful
   * for tests pinning a specific min-out without recomputing.
   */
  computeMinAmountOut?: (input: { expectedOutLamports: bigint | null; slippageBps: number }) => bigint;
}

function defaultMinAmountOut(input: { expectedOutLamports: bigint | null; slippageBps: number }): bigint {
  if (input.expectedOutLamports === null) {
    // Historical placeholder per `CloseOrchestrationAdapter.submitSwap`
    // doc — no quote, no min-out protection. The orchestrator's
    // documented behaviour, kept stable here.
    return 1n;
  }
  const bps = BigInt(input.slippageBps);
  return (input.expectedOutLamports * (10_000n - bps)) / 10_000n;
}

/**
 * Production `CloseOrchestrationAdapter`. Stateless given its deps;
 * one instance can serve every close request at boot.
 */
export function createProductionCloseAdapter(
  deps: ProductionCloseAdapterDeps,
): CloseOrchestrationAdapter {
  const minOut = deps.computeMinAmountOut ?? defaultMinAmountOut;

  async function loadCtx(positionId: string, leg: string): Promise<CloseOrchestrationPositionContext> {
    if (!deps.contextResolver) {
      throw new CloseOrchestrationWiringIncompleteError(leg, "contextResolver");
    }
    return deps.contextResolver(positionId);
  }

  return {
    async submitWithdrawClose(input) {
      const ctx = await loadCtx(input.positionId, "submitWithdrawClose");
      const ix = await deps.executorClient.buildWithdrawCloseIx({
        stealth: ctx.stealthKeypair.publicKey,
        lbPair: ctx.lbPair,
        dlmmRemainingAccounts: ctx.withdrawCloseRemainingAccounts,
        fromBinId: ctx.fromBinId,
        toBinId: ctx.toBinId,
        bpsToRemove: 10_000, // 100% — closing the position
        remainingAccountsInfo: ctx.remainingAccountsInfo,
      });
      const signature = await deps.executorClient.sendIx(ix, [ctx.stealthKeypair], {
        computeUnits: 1_400_000,
      });
      // production-ix-wiring/02 — read the stealth's other-side ATA
      // balance via the chain seam. `null` ATA = single-sided SOL pool
      // → 0n short-circuits the orchestrator's swap leg via its
      // existing dust-threshold gate.
      const otherSideResidualLamports = await readOtherSideResidual(
        deps.chain,
        ctx.stealthOtherAta ?? null,
      );
      return { signature, otherSideResidualLamports };
    },

    async submitSwap(input) {
      const ctx = await loadCtx(input.positionId, "submitSwap");
      if (!ctx.swapRemainingAccounts) {
        throw new CloseOrchestrationWiringIncompleteError(
          "submitSwap",
          "swapRemainingAccounts",
        );
      }
      const minAmountOut = minOut({
        expectedOutLamports: input.expectedOutLamports,
        slippageBps: input.slippageBps,
      });
      const ix = await deps.executorClient.buildSwapIx({
        stealth: ctx.stealthKeypair.publicKey,
        lbPair: ctx.lbPair,
        dlmmRemainingAccounts: ctx.swapRemainingAccounts,
        amountIn: input.residualLamports,
        minAmountOut,
        remainingAccountsInfo: ctx.remainingAccountsInfo,
      });
      const signature = await deps.executorClient.sendIx(ix, [ctx.stealthKeypair], {
        computeUnits: 1_400_000,
      });
      return { signature };
    },

    async submitMixerDeposit(input) {
      const ctx = await loadCtx(input.positionId, "submitMixerDeposit");
      const mixer = deps.mixerServiceFor(ctx.denomination);
      // The mixer-deposit ix accepts a commitment + depositor. The
      // commitment preimage stays browser-side (custodial-less per the
      // privacy invariant); the relayer-signed path here uses the
      // resolved `remixCommitment` (also browser-generated and supplied
      // via context). `buildDepositTransaction` returns an unsigned tx;
      // a future ticket lands the relayer-side signer + submission.
      const unsigned = await mixer.buildDepositTransaction({
        depositorPubkey: ctx.stealthKeypair.publicKey.toBase58(),
        commitment: ctx.remixCommitment,
      });
      // production-ix-wiring/02 — sign + submit with the stealth keypair.
      // The mixer service produced a base64 legacy Transaction with
      // feePayer = stealth + compute-budget + deposit ix + a recent
      // blockhash. We refresh blockhash, partial-sign, and broadcast via
      // the chain seam (so ScriptedChain can drive tests).
      const signature = await submitStealthSignedDeposit(
        deps,
        unsigned.transaction,
        ctx.stealthKeypair,
      );
      return { signature };
    },
  };
}

/**
 * Deserialize the unsigned base64 deposit transaction, sign with the
 * stealth keypair, and submit-and-confirm via the chain.
 */
async function submitStealthSignedDeposit(
  deps: ProductionCloseAdapterDeps,
  unsignedBase64: string,
  stealth: Keypair,
): Promise<string> {
  const tx = Transaction.from(Buffer.from(unsignedBase64, "base64"));
  const { blockhash, lastValidBlockHeight } = await deps.chain.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = stealth.publicKey;
  tx.partialSign(stealth);
  const raw = tx.serialize();
  const conn = deps.chain.rawConnection();
  const signature = await conn.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

/**
 * Read the SPL token amount on `ata` via the chain seam. Returns 0n
 * for a null ATA (single-sided SOL pool) or a non-existent account.
 */
async function readOtherSideResidual(
  chain: SolanaChain,
  ata: PublicKey | null,
): Promise<bigint> {
  if (!ata) return 0n;
  const acct = await chain.getAccountInfo(ata, "confirmed");
  if (!acct || acct.data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return 0n;
  return acct.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}
