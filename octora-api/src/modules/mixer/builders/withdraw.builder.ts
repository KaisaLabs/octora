/**
 * Build the unsigned `withdraw` transaction for the user (or relayer)
 * to sign and submit. Pure given `MixerTxContext` + args; doesn't
 * touch in-memory pool state. Callers that need anonymity-set or
 * pool-initialized preflight (the standard path,
 * `MixerService.buildWithdrawTransaction`) run those assertions
 * before calling this.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { bigintToBytes32 } from "#common/solana/field-encoding";

import type { MixerTxContext } from "./types.js";

const NULLIFIER_SEED = Buffer.from("nullifier");

export interface BuildWithdrawArgs {
  signerPubkey: string;
  recipientPubkey: string;
  proofBytesBase64: string;
  publicInputsBytesBase64: string;
  nullifierHash: string;
}

export async function buildWithdrawTransaction(
  ctx: MixerTxContext,
  args: BuildWithdrawArgs,
): Promise<{ transaction: string }> {
  const signer = new PublicKey(args.signerPubkey);
  const recipient = new PublicKey(args.recipientPubkey);
  const nullifierHashBuf = bigintToBytes32(BigInt(args.nullifierHash), "nullifierHash");

  const proofBytes = Buffer.from(args.proofBytesBase64, "base64");
  const publicInputsBytes = Buffer.from(args.publicInputsBytesBase64, "base64");

  const [nullifierPDA] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, ctx.poolPDA.toBuffer(), nullifierHashBuf],
    ctx.programId,
  );

  const ix = await ctx.program.methods
    .withdraw(Array.from(proofBytes), Array.from(publicInputsBytes))
    .accounts({
      signer,
      mixerPool: ctx.poolPDA,
      nullifierAccount: nullifierPDA,
      recipient,
      relayer: signer,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const { blockhash } = await ctx.chain.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: signer });
  tx.add(computeIx, ix);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return { transaction: serialized.toString("base64") };
}
