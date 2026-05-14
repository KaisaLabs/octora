/**
 * Build the unsigned `deposit` transaction for the user to sign and
 * submit. Pure given `MixerTxContext` + args; doesn't touch in-memory
 * pool state. Callers that need a pool-initialized preflight (the
 * standard path, `MixerService.buildDepositTransaction`) run the
 * assertion before calling this.
 *
 * The deposit ix performs 20 Poseidon syscalls during incremental
 * Merkle insertion, so we bump the compute budget above the 200k
 * default.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { bigintToBytes32 } from "#common/solana/field-encoding";

import type { MixerTxContext } from "./types.js";

const COMMITMENT_SEED = Buffer.from("commitment");

export interface BuildDepositArgs {
  depositorPubkey: string;
  commitment: bigint;
}

export async function buildDepositTransaction(
  ctx: MixerTxContext,
  args: BuildDepositArgs,
): Promise<{ transaction: string }> {
  const depositor = new PublicKey(args.depositorPubkey);
  const commitmentBytes = bigintToBytes32(args.commitment, "commitment");

  const [commitmentPDA] = PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, ctx.poolPDA.toBuffer(), commitmentBytes],
    ctx.programId,
  );

  const ix = await ctx.program.methods
    .deposit(Array.from(commitmentBytes))
    .accounts({
      depositor,
      mixerPool: ctx.poolPDA,
      commitmentAccount: commitmentPDA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const { blockhash } = await ctx.chain.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: depositor });
  tx.add(computeIx, ix);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return { transaction: serialized.toString("base64") };
}
