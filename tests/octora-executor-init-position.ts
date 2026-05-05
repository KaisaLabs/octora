import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { expect } from "chai";

// ─── Constants matching the on-chain executor ──────────────────────────

const POSITION_AUTHORITY_SEED = Buffer.from("position-authority");

// Mainnet IDs cloned into the local validator via Anchor.toml.
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const LB_PAIR = new PublicKey(
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", // SOL/USDC, top-TVL DLMM pool
);
const EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6", // DLMM `__event_authority` PDA
);

// ─── Helpers ───────────────────────────────────────────────────────────

function derivePositionAuthority(
  programId: PublicKey,
  stealth: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_AUTHORITY_SEED, stealth.toBuffer()],
    programId,
  );
}

/**
 * Anchor-style discriminator: `sha256("global:<ix>")[..8]`.
 * Mirrors what the executor program computes at runtime so tests can build
 * raw ixs that the on-chain handler will recognise.
 */
async function anchorDiscriminator(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  const digest = createHash("sha256").update(`global:${ix}`).digest();
  return digest.subarray(0, 8);
}

async function fundAccount(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  await provider.sendAndConfirm(tx);
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("octora-executor :: init_position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;
  const payer = provider.wallet as anchor.Wallet;

  // Each test gets a fresh stealth wallet so we don't collide on the
  // PositionAuthority PDA across runs.
  let stealth: Keypair;
  let positionAuthority: PublicKey;
  let positionKeypair: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    [positionAuthority] = derivePositionAuthority(programId, stealth.publicKey);
    positionKeypair = Keypair.generate();

    // Stealth wallet only needs to cover the rent for PositionAuthority
    // (~0.0016 SOL). Payer covers the much larger DLMM Position account.
    await fundAccount(provider, stealth.publicKey, 0.01 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("creates PositionAuthority PDA and a DLMM-owned position via CPI", async () => {
    // Args for DLMM `initialize_position`: (lower_bin_id: i32, width: i32).
    // A small symmetric range is fine — we're testing the CPI plumbing,
    // not strategy parameters.
    const lowerBinId = -10;
    const width = 20;

    // Build the executor ix manually so we control `remaining_accounts`
    // ordering exactly as DLMM's `initialize_position` expects.
    const disc = await anchorDiscriminator("init_position");
    const argsBuf = Buffer.alloc(8);
    argsBuf.writeInt32LE(lowerBinId, 0);
    argsBuf.writeInt32LE(width, 4);
    const data = Buffer.concat([disc, argsBuf]);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },     // 0: payer
      { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true }, // 1: position
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },            // 2: lb_pair
      { pubkey: positionAuthority, isSigner: false, isWritable: false },  // 3: owner — re-pinned to PDA inside the program; pubkey here MUST match for AccountInfo lookup
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4: system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // 5: rent
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },    // 6: event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },    // 7: program
    ];

    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },        // outer: stealth
      { pubkey: positionAuthority, isSigner: false, isWritable: true },       // outer: position_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },        // outer: dlmm_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },// outer: system_program
      ...dlmmAccounts,
    ];

    const ix = new TransactionInstruction({
      programId,
      keys: accounts,
      data,
    });

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ix);

    await provider.sendAndConfirm(tx, [stealth, positionKeypair]);

    // ── Assertions ────────────────────────────────────────────────────

    // 1. PositionAuthority PDA exists with the fields we set in the handler.
    const pa = await (program.account as any).positionAuthority.fetch(
      positionAuthority,
    );
    expect(pa.stealthPubkey.toBase58()).to.equal(stealth.publicKey.toBase58());
    expect(pa.lbPair.toBase58()).to.equal(LB_PAIR.toBase58());
    expect(pa.position.toBase58()).to.equal(positionKeypair.publicKey.toBase58());

    // 2. The DLMM position account was created and is owned by DLMM.
    //    That's the smoke test for the CPI: if the CPI failed we'd never
    //    have got here (sendAndConfirm would have thrown).
    const positionInfo = await provider.connection.getAccountInfo(
      positionKeypair.publicKey,
    );
    expect(positionInfo, "DLMM position account should exist").to.not.be.null;
    expect(positionInfo!.owner.toBase58()).to.equal(DLMM_PROGRAM_ID.toBase58());
  });

  it("rejects a second init for the same stealth (PDA already exists)", async () => {
    // Re-running with the same stealth tries to `init` the same PDA →
    // Anchor returns an InitError. This guards against accidentally
    // re-using a stealth wallet for two positions.
    const secondPosition = Keypair.generate();

    const disc = await anchorDiscriminator("init_position");
    const argsBuf = Buffer.alloc(8);
    argsBuf.writeInt32LE(0, 0);
    argsBuf.writeInt32LE(10, 4);
    const data = Buffer.concat([disc, argsBuf]);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: secondPosition.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionAuthority, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    const ix = new TransactionInstruction({ programId, keys: accounts, data });
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ix);

    let threw = false;
    try {
      await provider.sendAndConfirm(tx, [stealth, secondPosition]);
    } catch (err) {
      threw = true;
    }
    expect(threw, "second init for the same stealth must fail").to.equal(true);
  });
});
