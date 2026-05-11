/**
 * DLMM swap client — builds an unsigned `dlmm_swap` transaction for the
 * stealth wallet to sign and submit.
 *
 * Mirrors the buildAddLiquidityTx pattern in `executor.service.ts`: the
 * server pre-signs as fee payer (via the relayer keypair) and returns
 * a base64 tx that the browser augments with the stealth signature
 * before broadcasting.
 *
 * Same-pool reject is enforced by the swap.service caller; this client
 * trusts its inputs and only fails on wiring errors (unknown pool,
 * unreachable RPC, etc.).
 */

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveOracle,
  deriveReserve,
} from "@meteora-ag/dlmm";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// IDL is shared with the existing on-chain executor client. Copying the
// path keeps a single source of truth for the executor IDL.
const IDL_PATH = join(__dirname, "..", "..", "execution", "clients", "idl", "octora_executor.json");

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);

export interface DlmmSwapClientOptions {
  rpcUrl: string;
  /** Hot wallet that pays fees and pre-signs the tx. */
  relayerKeypair: Keypair;
  /** Deployed octora-executor program id. */
  executorProgramId: PublicKey;
}

export interface BuildSwapTxArgs {
  /** Stealth wallet that will sign + submit. */
  stealth: PublicKey;
  /** Source pool's lb_pair (NOT the LP target pool). */
  lbPair: PublicKey;
  /** Lamports to pay in. The stealth must hold this amount in
   *  `tokenIn`. */
  amountIn: bigint;
  /** Slippage-protected lower bound on output token (lamports). */
  minAmountOut: bigint;
  /** Direction flag — DLMM-side. */
  swapForY: boolean;
}

export interface BuildSwapTxResult {
  /** Base64-encoded partially-signed tx. Browser adds stealth signature
   *  and submits. */
  transaction: string;
  /** Recommended source / destination ATAs the caller may want to
   *  display. */
  userTokenIn: string;
  userTokenOut: string;
}

export class DlmmSwapClient {
  private connection: Connection;
  private relayer: Keypair;
  private programId: PublicKey;
  private program: Program;
  private provider: AnchorProvider;

  constructor(opts: DlmmSwapClientOptions) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
    this.relayer = opts.relayerKeypair;
    this.programId = opts.executorProgramId;
    const wallet = new Wallet(this.relayer);
    this.provider = new AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    this.program = new Program(idl, this.provider);
  }

  /**
   * Build the unsigned `dlmm_swap` tx. Server pre-signs as fee payer; the
   * stealth wallet's signature is the only thing missing.
   *
   * Account layout matches programs/octora-executor/src/instructions/dlmm/swap.rs.
   */
  async buildSwapTx(args: BuildSwapTxArgs): Promise<BuildSwapTxResult> {
    const dlmm = await DLMM.create(this.connection, args.lbPair);
    const tokenX = dlmm.lbPair.tokenXMint;
    const tokenY = dlmm.lbPair.tokenYMint;

    const [reserveX] = deriveReserve(tokenX, args.lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, args.lbPair, DLMM_PROGRAM_ID);
    const [oracle] = deriveOracle(args.lbPair, DLMM_PROGRAM_ID);

    // Bin arrays straddling the active bin. DLMM swap consumes whichever
    // bins the price moves through; we pass two arrays around the active
    // bin so a typical swap stays inside this window.
    const activeIdx = binIdToBinArrayIndex(new BN(dlmm.lbPair.activeId));
    const [binArray0] = deriveBinArray(args.lbPair, activeIdx, DLMM_PROGRAM_ID);
    const [binArray1] = deriveBinArray(
      args.lbPair,
      activeIdx.add(new BN(args.swapForY ? -1 : 1)),
      DLMM_PROGRAM_ID,
    );

    // User token ATAs — owned by the stealth, mints derived from swap
    // direction.
    const inputMint = args.swapForY ? tokenX : tokenY;
    const outputMint = args.swapForY ? tokenY : tokenX;
    const userTokenIn = getAssociatedTokenAddressSync(inputMint, args.stealth);
    const userTokenOut = getAssociatedTokenAddressSync(outputMint, args.stealth);

    // Match programs/octora-executor/src/instructions/dlmm/swap.rs layout.
    const remainingMetas: AccountMeta[] = [
      { pubkey: args.lbPair, isSigner: false, isWritable: true },                // 0 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },            // 1 bitmap_ext sentinel
      { pubkey: reserveX, isSigner: false, isWritable: true },                   // 2 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },                   // 3 reserve_y
      { pubkey: userTokenIn, isSigner: false, isWritable: true },                // 4 user_token_in
      { pubkey: userTokenOut, isSigner: false, isWritable: true },               // 5 user_token_out
      { pubkey: tokenX, isSigner: false, isWritable: false },                    // 6 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                    // 7 token_y_mint
      { pubkey: oracle, isSigner: false, isWritable: true },                     // 8 oracle
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },            // 9 host_fee_in sentinel
      { pubkey: args.stealth, isSigner: true, isWritable: true },                // 10 user
      // MAINNET_BLOCKER: Token-2022 — branch off mint owner.
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },          // 11 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },          // 12 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },      // 13 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },           // 14 dlmm_program
      { pubkey: binArray0, isSigner: false, isWritable: true },                  // 15 bin_array_0
      { pubkey: binArray1, isSigner: false, isWritable: true },                  // 16 bin_array_1
    ];

    const [configPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.programId,
    );

    const ix = await this.program.methods
      .dlmmSwap(new BN(args.amountIn.toString()), new BN(args.minAmountOut.toString()))
      .accounts({
        stealth: args.stealth,
        dlmmProgram: DLMM_PROGRAM_ID,
        lbPair: args.lbPair,
        config: configPDA,
      })
      .remainingAccounts(remainingMetas)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: this.relayer.publicKey,
    });
    tx.add(computeIx, ix);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return {
      transaction: serialized.toString("base64"),
      userTokenIn: userTokenIn.toBase58(),
      userTokenOut: userTokenOut.toBase58(),
    };
  }
}
