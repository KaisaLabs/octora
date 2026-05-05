/**
 * Lifecycle test: init_position → claim_fees → withdraw_close.
 *
 * Why this test focuses on the exit_recipient boundary, not happy-path
 * token flows:
 *   The cloned LB pair is SOL/USDC mainnet. We can wrap SOL locally, but
 *   USDC's mint authority is Circle — we can't mint test USDC into a
 *   localnet ATA, so a "real" add_liquidity → claim → withdraw_close
 *   round-trip needs a fresh LB pair built with mints we control. That's
 *   substantial test infra (preset_parameter clone + createLbPair +
 *   bin-array init).
 *
 *   What we *can* exercise meaningfully today is the executor's
 *   contribution: enforcing that fees and withdrawal proceeds can only
 *   land at PositionAuthority.exit_recipient. These tests build each
 *   Phase-2 ix with one tampered account and assert that our program
 *   rejects the call BEFORE forwarding the CPI to DLMM.
 *
 *   Happy-path lifecycle test is tracked separately as Phase 4 (fresh
 *   pair on local mints).
 */

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
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAccount,
} from "@solana/spl-token";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────

const POSITION_AUTHORITY_SEED = Buffer.from("position-authority");

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const LB_PAIR = new PublicKey(
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
);
const EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);

// Custom error code from `ExecutorError::ExitRecipientMismatch`.
// Anchor numbers user errors starting at 6000; this is the 5th variant.
//   DlmmProgramMismatch     = 6000
//   PositionMismatch        = 6001
//   LbPairMismatch          = 6002
//   StealthMismatch         = 6003
//   ExitRecipientMismatch   = 6004
//   InvalidTokenAccount     = 6005
const ERR_EXIT_RECIPIENT_MISMATCH = 6004;

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

async function anchorDiscriminator(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
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

/** Extract the Anchor custom error code from a sendAndConfirm failure. */
function extractAnchorErrorCode(err: any): number | null {
  // Anchor surfaces logs like "Program log: AnchorError ... Error Number: 6004."
  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  // Newer error format embeds the code in the message
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (m2) return parseInt(m2[1], 16);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("octora-executor :: lifecycle (security boundary)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;
  const payer = provider.wallet as anchor.Wallet;

  let stealth: Keypair;
  let positionAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;

  // SPL token accounts owned by the LEGITIMATE exit_recipient. Used at
  // every slot the program reads, so the only unhappy field is the one
  // each negative test deliberately swaps out.
  let goodUserTokenX: PublicKey;
  let goodUserTokenY: PublicKey;

  // Same shape, but owned by a foreign attacker pubkey. Substituting one
  // of these is what each test uses to trip the constraint.
  let badUserTokenX: PublicKey;
  let attacker: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    [positionAuthority] = derivePositionAuthority(programId, stealth.publicKey);
    exitRecipient = payer.publicKey;
    attacker = Keypair.generate();

    await fundAccount(
      provider,
      stealth.publicKey,
      0.01 * anchor.web3.LAMPORTS_PER_SOL,
    );

    // ── Step 1: init_position (happy path) ───────────────────────────
    //
    // This is the same flow as the init_position test, included here
    // because the negative tests below need a real PositionAuthority and
    // position to target. wSOL is fine for the position keypair — DLMM
    // doesn't care what mint the position is for at init time, only that
    // it matches the LB pair's mints.
    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;

    const initDisc = await anchorDiscriminator("init_position");
    const initArgs = Buffer.alloc(8 + 32);
    initArgs.writeInt32LE(-10, 0);
    initArgs.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(initArgs, 8);

    const initDlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const initAccounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionAuthority, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...initDlmmAccounts,
    ];

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(
          new TransactionInstruction({
            programId,
            keys: initAccounts,
            data: Buffer.concat([initDisc, initArgs]),
          }),
        ),
      [stealth, positionKp],
    );

    // ── Step 2: prepare token accounts ────────────────────────────────
    //
    // Both legitimate ATAs are wSOL accounts owned by exit_recipient. We
    // don't use the LB pair's USDC mint here — the program never reads
    // `.mint`, only `.owner`, so wSOL on both slots is sufficient to
    // reach the constraint check that the test exercises.
    goodUserTokenX = await createAccount(
      provider.connection,
      payer.payer,
      NATIVE_MINT,
      exitRecipient,
      Keypair.generate(),
    );
    goodUserTokenY = await createAccount(
      provider.connection,
      payer.payer,
      NATIVE_MINT,
      exitRecipient,
      Keypair.generate(),
    );
    badUserTokenX = await createAccount(
      provider.connection,
      payer.payer,
      NATIVE_MINT,
      attacker.publicKey,
      Keypair.generate(),
    );
  });

  // ── claim_fees ─────────────────────────────────────────────────────

  it("init_position persisted exit_recipient on PositionAuthority", async () => {
    const pa = await (program.account as any).positionAuthority.fetch(
      positionAuthority,
    );
    expect(pa.exitRecipient.toBase58()).to.equal(exitRecipient.toBase58());
    expect(pa.position.toBase58()).to.equal(positionPubkey.toBase58());
    expect(pa.lbPair.toBase58()).to.equal(LB_PAIR.toBase58());
  });

  it("claim_fees rejects user_token_x not owned by exit_recipient", async () => {
    // The bin arrays / reserves passed below are placeholder pubkeys —
    // DLMM never sees this ix because our program errors out on the
    // user_token_x.owner check at remaining_accounts[7].
    const placeholder = Keypair.generate().publicKey;

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },              // 0 lb_pair
      { pubkey: positionPubkey, isSigner: false, isWritable: true },       // 1 position
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 2 bin_array_lower
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 3 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },   // 4 sender (re-pinned in program)
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 5 reserve_x
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 6 reserve_y
      { pubkey: badUserTokenX, isSigner: false, isWritable: true },        // 7 user_token_x  ← bad
      { pubkey: goodUserTokenY, isSigner: false, isWritable: true },       // 8 user_token_y
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },         // 9 token_x_mint
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },         // 10 token_y_mint
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    // 11 token_program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },     // 12 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },     // 13 program
    ];

    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    const ix = new TransactionInstruction({
      programId,
      keys: accounts,
      data: await anchorDiscriminator("claim_fees"),
    });

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth]);
    } catch (err) {
      code = extractAnchorErrorCode(err);
    }
    expect(code, "expected ExitRecipientMismatch").to.equal(
      ERR_EXIT_RECIPIENT_MISMATCH,
    );
  });

  // ── withdraw_close ─────────────────────────────────────────────────

  function buildWithdrawCloseIx(opts: {
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    rentReceiver: PublicKey;
    discriminator: Buffer;
  }): TransactionInstruction {
    const placeholder = Keypair.generate().publicKey;

    // Match the 17-account layout from withdraw_close.rs.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },        // 0 position
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },               // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },       // 2 bin_array_bitmap_ext (placeholder = program-owned ⇒ None)
      { pubkey: opts.userTokenX, isSigner: false, isWritable: true },       // 3 user_token_x
      { pubkey: opts.userTokenY, isSigner: false, isWritable: true },       // 4 user_token_y
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 5 reserve_x
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 6 reserve_y
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },          // 7 token_x_mint
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },          // 8 token_y_mint
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 9 bin_array_lower
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },    // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 13 token_y_program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },      // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },      // 15 program
      { pubkey: opts.rentReceiver, isSigner: false, isWritable: true },     // 16 rent_receiver
    ];

    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    // Args: from_bin_id (i32), to_bin_id (i32), bps_to_remove (u16)
    const args = Buffer.alloc(10);
    args.writeInt32LE(-10, 0);
    args.writeInt32LE(10, 4);
    args.writeUInt16LE(10000, 8); // 100%

    return new TransactionInstruction({
      programId,
      keys: accounts,
      data: Buffer.concat([opts.discriminator, args]),
    });
  }

  it("withdraw_close rejects user_token_x not owned by exit_recipient", async () => {
    const disc = await anchorDiscriminator("withdraw_close");
    const ix = buildWithdrawCloseIx({
      userTokenX: badUserTokenX,
      userTokenY: goodUserTokenY,
      rentReceiver: exitRecipient,
      discriminator: disc,
    });

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth]);
    } catch (err) {
      code = extractAnchorErrorCode(err);
    }
    expect(code, "expected ExitRecipientMismatch on user_token_x").to.equal(
      ERR_EXIT_RECIPIENT_MISMATCH,
    );
  });

  it("withdraw_close rejects rent_receiver != exit_recipient", async () => {
    const disc = await anchorDiscriminator("withdraw_close");
    const ix = buildWithdrawCloseIx({
      userTokenX: goodUserTokenX,
      userTokenY: goodUserTokenY,
      rentReceiver: attacker.publicKey, // ← bad
      discriminator: disc,
    });

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth]);
    } catch (err) {
      code = extractAnchorErrorCode(err);
    }
    expect(code, "expected ExitRecipientMismatch on rent_receiver").to.equal(
      ERR_EXIT_RECIPIENT_MISMATCH,
    );
  });
});
