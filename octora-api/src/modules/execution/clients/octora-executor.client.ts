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

export const POSITION_AUTHORITY_SEED = Buffer.from("position-authority");

/**
 * Meteora DLMM (LB CLMM) on mainnet/devnet.
 * Mirrors `programs/octora-executor/src/constants.rs::DLMM_PROGRAM_ID`.
 */
export const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);

/** DLMM `__event_authority` PDA. Required by every DLMM ix that emits events. */
export const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);

/** SPL token program. Repeated here so callers don't need to import @solana/spl-token. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export interface OctoraExecutorClientOptions {
  connection: Connection;
  /** Relayer hot wallet — pays gas for executor txs. Does NOT sign as the position authority. */
  relayerKeypair: Keypair;
  programId: PublicKey;
  /** Optional IDL override; defaults to the one shipped under `clients/idl/`. */
  idl?: unknown;
}

export interface InitPositionParams {
  stealth: PublicKey;
  /** Fresh keypair for the DLMM position account. Caller owns it & must include it as a signer. */
  positionPubkey: PublicKey;
  lbPair: PublicKey;
  exitRecipient: PublicKey;
  lowerBinId: number;
  width: number;
}

export interface AddLiquidityParams {
  stealth: PublicKey;
  /** Pre-built DLMM `add_liquidity_by_strategy` ix account list (16 entries — see add_liquidity.rs). */
  dlmmRemainingAccounts: AccountMeta[];
  /** Borsh-encoded `LiquidityParameterByStrategy`. We forward as bytes; caller is responsible for the schema. */
  liquidityParams: Buffer;
}

export interface ClaimFeesParams {
  stealth: PublicKey;
  /** DLMM `claim_fee` account list (14 entries — see claim_fees.rs). */
  dlmmRemainingAccounts: AccountMeta[];
}

export interface WithdrawCloseParams {
  stealth: PublicKey;
  /** DLMM remove+close union account list (17 entries — see withdraw_close.rs). */
  dlmmRemainingAccounts: AccountMeta[];
  fromBinId: number;
  toBinId: number;
  bpsToRemove: number;
}

/**
 * Low-level client around the on-chain `octora-executor` program.
 *
 * Exposes one builder method per executor ix that returns a
 * `TransactionInstruction`. Callers compose these into transactions and
 * decide which signers to add (stealth + maybe a fresh `position` keypair).
 *
 * The constructor takes a relayer hot wallet, but the wallet only ever
 * signs as fee payer — the security-critical signers (stealth, position
 * authority PDA via `invoke_signed`) are handled by the program itself or
 * supplied at sign time.
 */
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
    this.program = new Program(idl as any, provider);
    this.programId = opts.programId;
    this.provider = provider;
    this.relayerKeypair = opts.relayerKeypair;
  }

  /** Derive the `PositionAuthority` PDA for a given stealth wallet. */
  derivePositionAuthority(stealth: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, stealth.toBuffer()],
      this.programId,
    );
  }

  /**
   * Build the `init_position` ix.
   *
   * Outer signers required at sign time: `stealth` and the `position` keypair.
   * Fee payer: this client's `relayerKeypair`.
   */
  async buildInitPositionIx(p: InitPositionParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePositionAuthority(p.stealth);

    return this.program.methods
      .initPosition(p.lowerBinId, p.width, p.exitRecipient)
      .accounts({
        stealth: p.stealth,
        positionAuthority: pa,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        // DLMM `initialize_position` account list — see init_position.rs docstring.
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: p.positionPubkey, isSigner: true, isWritable: true },
        { pubkey: p.lbPair, isSigner: false, isWritable: false },
        { pubkey: pa, isSigner: false, isWritable: false }, // re-pinned to PDA inside the program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ])
      .instruction();
  }

  /** Build the `add_liquidity` ix. Stealth is the only outer signer required. */
  async buildAddLiquidityIx(p: AddLiquidityParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePositionAuthority(p.stealth);

    return this.program.methods
      .addLiquidity(p.liquidityParams)
      .accounts({
        stealth: p.stealth,
        positionAuthority: pa,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  /** Build the `claim_fees` ix. Stealth is the only outer signer required. */
  async buildClaimFeesIx(p: ClaimFeesParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePositionAuthority(p.stealth);

    return this.program.methods
      .claimFees()
      .accounts({
        stealth: p.stealth,
        positionAuthority: pa,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  /** Build the `withdraw_close` ix. Stealth is the only outer signer required. */
  async buildWithdrawCloseIx(p: WithdrawCloseParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePositionAuthority(p.stealth);

    return this.program.methods
      .withdrawClose(p.fromBinId, p.toBinId, p.bpsToRemove)
      .accounts({
        stealth: p.stealth,
        positionAuthority: pa,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  /**
   * Convenience: send a tx wrapping a single executor ix with sensible defaults
   * (compute-unit bump for the DLMM CPIs). Caller passes any extra signers.
   */
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

  /** Fetch a `PositionAuthority` account by its PDA. */
  async fetchPositionAuthority(pda: PublicKey): Promise<{
    stealthPubkey: PublicKey;
    lbPair: PublicKey;
    position: PublicKey;
    exitRecipient: PublicKey;
    bump: number;
  }> {
    const acct = await (this.program.account as any).positionAuthority.fetch(pda);
    return {
      stealthPubkey: acct.stealthPubkey as PublicKey,
      lbPair: acct.lbPair as PublicKey,
      position: acct.position as PublicKey,
      exitRecipient: acct.exitRecipient as PublicKey,
      bump: acct.bump as number,
    };
  }
}

function loadDefaultIdl(): unknown {
  return JSON.parse(readFileSync(IDL_PATH, "utf-8"));
}

// Re-export so callers don't need a second import for BN math on bin IDs / amounts.
export { BN };
