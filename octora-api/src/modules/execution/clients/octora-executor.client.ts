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
}

export interface WithdrawCloseParams {
  stealth: PublicKey;
  lbPair: PublicKey;
  dlmmRemainingAccounts: AccountMeta[];
  fromBinId: number;
  toBinId: number;
  bpsToRemove: number;
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

  async buildInitPositionIx(p: InitPositionParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);

    return (this.program.methods as any)
      .dlmmInitPosition(p.lowerBinId, p.width, p.exitRecipient)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
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

    return (this.program.methods as any)
      .dlmmAddLiquidity(p.liquidityParams)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  async buildClaimFeesIx(p: ClaimFeesParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);

    return (this.program.methods as any)
      .dlmmClaimFees()
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(p.dlmmRemainingAccounts)
      .instruction();
  }

  async buildWithdrawCloseIx(p: WithdrawCloseParams): Promise<TransactionInstruction> {
    const [pa] = this.derivePoolAuthority(p.stealth, p.lbPair);

    return (this.program.methods as any)
      .dlmmWithdrawClose(p.fromBinId, p.toBinId, p.bpsToRemove)
      .accounts({
        stealth: p.stealth,
        poolAuthority: pa,
        lbPair: p.lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
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
