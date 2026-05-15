/**
 * production-ix-wiring/02 — per-leg ix builders for the user-signed
 * close-recovery service (close/06).
 *
 * The close-builder service ({@link buildCloseRecoveryTx}) assembles
 * an unsigned transaction the browser stealth-signs and broadcasts.
 * Each leg's ixs come from one of three sources:
 *
 *   - `withdraw-close` — executor's `dlmm_withdraw_close` wrapper.
 *   - `swap` — executor's `dlmm_swap` wrapper.
 *   - `mixer-deposit` — mixer program's `deposit` ix.
 *
 * The resolver supplies the per-position fields; the orchestrator and
 * the user-signed recovery path share the same context.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { OctoraExecutorClient } from "#modules/execution/clients";
import type { MixerService } from "#modules/mixer/mixer.service";

import type { CloseRecoveryLegBuilders } from "../position.close-builder.service";

import type { CloseContextResolverService } from "./close-context-resolver";

export interface CloseBuilderLegBuildersDeps {
  executorClient: OctoraExecutorClient;
  mixerServiceFor: (denomination: bigint) => MixerService;
  resolver: CloseContextResolverService;
}

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  "ComputeBudget111111111111111111111111111111",
);

export function createCloseBuilderLegBuilders(
  deps: CloseBuilderLegBuildersDeps,
): CloseRecoveryLegBuilders {
  return {
    async withdrawClose({ positionId }) {
      const ctx = await deps.resolver.resolveOrchestration(positionId);
      const ix = await deps.executorClient.buildWithdrawCloseIx({
        stealth: ctx.stealthKeypair.publicKey,
        lbPair: ctx.lbPair,
        dlmmRemainingAccounts: ctx.withdrawCloseRemainingAccounts,
        fromBinId: ctx.fromBinId,
        toBinId: ctx.toBinId,
        bpsToRemove: 10_000,
        remainingAccountsInfo: ctx.remainingAccountsInfo,
      });
      return [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ix,
      ];
    },

    async swap({ positionId, minAmountOutLamports, expectedSwapOutLamports }) {
      const ctx = await deps.resolver.resolveOrchestration(positionId);
      if (!ctx.swapRemainingAccounts) {
        throw new Error(
          `swap leg requested for position ${positionId} but the resolver returned no swap remaining-accounts (single-sided SOL pool).`,
        );
      }
      const amountIn = expectedSwapOutLamports ?? 0n;
      const ix = await deps.executorClient.buildSwapIx({
        stealth: ctx.stealthKeypair.publicKey,
        lbPair: ctx.lbPair,
        dlmmRemainingAccounts: ctx.swapRemainingAccounts,
        amountIn,
        minAmountOut: minAmountOutLamports,
        remainingAccountsInfo: ctx.remainingAccountsInfo,
      });
      return [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ix,
      ];
    },

    async mixerDeposit({ positionId, signer }) {
      const ctx = await deps.resolver.resolveOrchestration(positionId);
      const mixer = deps.mixerServiceFor(ctx.denomination);
      const unsigned = await mixer.buildDepositTransaction({
        depositorPubkey: signer.toBase58(),
        commitment: ctx.remixCommitment,
      });
      // Strip the embedded ComputeBudget so the close-builder service
      // can apply its own; re-add a sized one for the Poseidon-heavy
      // deposit ix.
      const tx = Transaction.from(Buffer.from(unsigned.transaction, "base64"));
      const inner: TransactionInstruction[] = tx.instructions.filter(
        (ix) => !ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID),
      );
      return [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...inner,
      ];
    },
  };
}
