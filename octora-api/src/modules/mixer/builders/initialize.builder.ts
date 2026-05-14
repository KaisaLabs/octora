/**
 * Build the unsigned `initialize` transaction. One-shot per
 * denomination — creates the on-chain `mixer_pool` PDA so subsequent
 * deposits / withdrawals have an account to read.
 *
 * The instruction encodes the pool denomination as a BN; the on-chain
 * program stores it in the pool account body and uses it as the
 * second PDA seed (`["mixer_pool", denomination.to_le_bytes()]`).
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import type { MixerTxContext } from "./types.js";

export interface BuildInitializeArgs {
  authorityPubkey: string;
}

export async function buildInitializeTransaction(
  ctx: MixerTxContext,
  args: BuildInitializeArgs,
): Promise<{ transaction: string; poolAddress: string }> {
  const authority = new PublicKey(args.authorityPubkey);

  const ix = await ctx.program.methods
    .initialize(new BN(ctx.denomination.toString()))
    .accounts({
      authority,
      mixerPool: ctx.poolPDA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await ctx.chain.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: authority });
  tx.add(ix);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString("base64"),
    poolAddress: ctx.poolPDA.toBase58(),
  };
}
