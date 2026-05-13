import type { PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

import type { BuilderContext } from "./types.js";

/**
 * Test-only token utilities. The relayer owns the mint authority for the
 * fresh mints created by `DlmmPoolBuilder.setupTestPair`, so it can mint
 * arbitrary balances to a test wallet's ATAs.
 */
export class TokenFactory {
  constructor(private ctx: BuilderContext) {}

  /** Mint test tokens to the given wallet's ATAs. Server signs with its mint authority. */
  async mintTestTokens(args: {
    owner: PublicKey;
    tokenX: PublicKey;
    tokenY: PublicKey;
    amountX: bigint;
    amountY: bigint;
  }): Promise<{ ataX: string; ataY: string }> {
    const { connection, relayer } = this.ctx;
    const ataX = await getOrCreateAssociatedTokenAccount(
      connection, relayer, args.tokenX, args.owner,
    );
    const ataY = await getOrCreateAssociatedTokenAccount(
      connection, relayer, args.tokenY, args.owner,
    );
    if (args.amountX > 0n) {
      await mintTo(
        connection, relayer, args.tokenX, ataX.address,
        relayer.publicKey, args.amountX,
      );
    }
    if (args.amountY > 0n) {
      await mintTo(
        connection, relayer, args.tokenY, ataY.address,
        relayer.publicKey, args.amountY,
      );
    }
    return { ataX: ataX.address.toBase58(), ataY: ataY.address.toBase58() };
  }
}
