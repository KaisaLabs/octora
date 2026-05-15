import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "idl", "octora_executor.json");

export const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
export const CONFIG_SEED = Buffer.from("config");

export const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);

export const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export interface OctoraExecutorClientOptions {
  connection: Connection;
  relayerKeypair: Keypair;
  programId: PublicKey;
  idl?: unknown;
}

export interface InitPositionParams {
  stealth: PublicKey;
  positionPubkey: PublicKey;
  lbPair: PublicKey;
  exitRecipient: PublicKey;
  lowerBinId: number;
  width: number;
}

export interface AddLiquidityParams {
  stealth: PublicKey;
  lbPair: PublicKey;
  dlmmRemainingAccounts: AccountMeta[];
  liquidityParams: Buffer;
}

export interface ClaimFeesParams {
  stealth: PublicKey;
  lbPair: PublicKey;
  dlmmRemainingAccounts: AccountMeta[];
  /** Inclusive bin range claim_fee2 collects across. */
  minBinId: number;
  maxBinId: number;
  /** Borsh-encoded `RemainingAccountsInfo` (empty Vec when no hooks). */
  remainingAccountsInfo: Buffer;
}

export interface WithdrawCloseParams {
  stealth: PublicKey;
  lbPair: PublicKey;
  dlmmRemainingAccounts: AccountMeta[];
  fromBinId: number;
  toBinId: number;
  bpsToRemove: number;
  /** Borsh-encoded `RemainingAccountsInfo` (empty Vec when no hooks). */
  remainingAccountsInfo: Buffer;
}

/**
 * close/01 — params for the executor's `dlmm_swap` wrapper.
 *
 * Source of truth: `programs/octora-executor/src/instructions/dlmm/swap.rs`.
 * The Anchor account struct is just the 4 outer slots (stealth signer,
 * dlmm_program, lb_pair, config); everything else — including
 * `user_token_in`, `user_token_out`, both mints, reserves, oracle, bin
 * arrays, transfer-hook accounts — flows through
 * `dlmmRemainingAccounts` (MIN_REMAINING = 17 in swap.rs). The caller
 * assembles that list from the live pool state and the stealth's ATAs.
 *
 * `amountIn` + `minAmountOut` arrive as `BN | bigint`; the IDL coerces
 * either to u64. `remainingAccountsInfo` is the same Borsh `Vec<u8>`
 * tail the other DLMM ixs use (empty `[0,0,0,0]` when no Token-2022
 * transfer hooks).
 */
export interface SwapParams {
  stealth: PublicKey;
  lbPair: PublicKey;
  dlmmRemainingAccounts: AccountMeta[];
  amountIn: BN | bigint;
  minAmountOut: BN | bigint;
  /** Borsh-encoded `RemainingAccountsInfo` (empty Vec when no hooks). */
  remainingAccountsInfo: Buffer;
}

export class OctoraExecutorClient {
  readonly program: Program;
  readonly programId: PublicKey;
  readonly provider: AnchorProvider;
  readonly relayerKeypair: Keypair;

  constructor(opts: OctoraExecutorClientOptions) {
    const wallet = new Wallet(opts.relayerKeypair);
    const provider = new AnchorProvider(opts.connection, wallet, {
      commitment: "confirmed",
    });
    const idl = opts.idl ?? loadDefaultIdl();
    (idl as { address: string }).address = opts.programId.toBase58();
    this.program = new Program(idl as any, provider);
    this.programId = opts.programId;
    this.provider = provider;
    this.relayerKeypair = opts.relayerKeypair;
  }

  /** Derive the PoolAuthority PDA: [pool-authority, stealth, pool] */
  derivePoolAuthority(stealth: PublicKey, poolKey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [POOL_AUTHORITY_SEED, stealth.toBuffer(), poolKey.toBuffer()],
      this.programId,
    );
  }

  /** Derive the global Config PDA: [config]. Required by every DLMM ix (pause gate). */
  deriveConfig(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId);
  }

  async buildInitPositionIx(p: InitPositionParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);
    const [config] = this.deriveConfig();

    return (this.program.methods as any)
      .dlmmInitPosition(p.lowerBinId, p.width, p.exitRecipient)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
        config,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: p.positionPubkey, isSigner: true, isWritable: true },
        { pubkey: p.lbPair, isSigner: false, isWritable: false },
        { pubkey: pa, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ])
      .instruction();
  }

  async buildAddLiquidityIx(p: AddLiquidityParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);
    const [config] = this.deriveConfig();

    return (this.program.methods as any)
      .dlmmAddLiquidity(p.liquidityParams)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
        config,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  async buildClaimFeesIx(p: ClaimFeesParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);
    const [config] = this.deriveConfig();

    return (this.program.methods as any)
      .dlmmClaimFees(p.minBinId, p.maxBinId, p.remainingAccountsInfo)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
        config,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  async buildWithdrawCloseIx(p: WithdrawCloseParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);
    const [config] = this.deriveConfig();

    return (this.program.methods as any)
      .dlmmWithdrawClose(p.fromBinId, p.toBinId, p.bpsToRemove, p.remainingAccountsInfo)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
        config,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  /**
   * Build the executor's `dlmm_swap` ix — the pause-gated, slippage-
   * enforced wrapper around Meteora DLMM `swap2`. The stealth signer
   * authorizes the inner ix (no PDA signing — see swap.rs trust model).
   *
   * `min_amount_out` is enforced both by DLMM's internal slippage check
   * and by the executor's pre/post `user_token_out.amount` read, so a
   * realized swap output below the cap reverts the tx and lets the
   * orchestrator land in `SWAP_FAILED`.
   *
   * The caller assembles `dlmmRemainingAccounts` per the layout in
   * swap.rs (16 fixed slots + ≥1 bin array, plus any transfer-hook tail).
   */
  async buildSwapIx(p: SwapParams): Promise<TransactionInstruction> {
    const [config] = this.deriveConfig();
    const amountInBn = p.amountIn instanceof BN ? p.amountIn : new BN(p.amountIn.toString());
    const minOutBn =
      p.minAmountOut instanceof BN ? p.minAmountOut : new BN(p.minAmountOut.toString());

    return (this.program.methods as any)
      .dlmmSwap(amountInBn, minOutBn, p.remainingAccountsInfo)
      .accounts({
        stealth: p.stealth,
        dlmmProgram: DLMM_PROGRAM_ID,
        lbPair: p.lbPair,
        config,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  async sendIx(
    ix: TransactionInstruction,
    extraSigners: Keypair[] = [],
    opts: { computeUnits?: number } = {},
  ): Promise<string> {
    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: opts.computeUnits ?? 600_000,
        }),
      )
      .add(ix);
    return this.provider.sendAndConfirm(tx, extraSigners);
  }

  async fetchPoolAuthority(pda: PublicKey): Promise<{
    stealthPubkey: PublicKey;
    lbPair: PublicKey;
    position: PublicKey;
    exitRecipient: PublicKey;
    bump: number;
  } | null> {
    const acct = await (this.program.account as any).poolAuthority.fetchNullable(pda);
    if (!acct) return null;
    return {
      stealthPubkey: acct.stealthPubkey as PublicKey,
      lbPair: acct.poolRef?.lbPair as PublicKey,
      position: acct.poolRef?.position as PublicKey,
      exitRecipient: acct.exitRecipient as PublicKey,
      bump: acct.bump as number,
    };
  }
}

function loadDefaultIdl(): unknown {
  return JSON.parse(readFileSync(IDL_PATH, "utf-8"));
}

export { BN };
