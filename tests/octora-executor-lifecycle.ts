/**
 * Lifecycle test: dlmm_init_position → dlmm_claim_fees → dlmm_withdraw_close.
 *
 * Focuses on the exit_recipient security boundary — testing that the
 * executor rejects tampered owner fields BEFORE forwarding the CPI to DLMM.
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

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const LB_PAIR = new PublicKey(
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
);
const EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);

const ERR_EXIT_RECIPIENT_MISMATCH = 6004;

// ─── Helpers ───────────────────────────────────────────────────────────

function derivePoolAuthority(
  programId: PublicKey,
  stealth: PublicKey,
  poolKey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), poolKey.toBuffer()],
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

function extractAnchorErrorCode(err: any): number | null {
  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
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
  const payer = (provider.wallet as anchor.Wallet).payer;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;

  let goodUserTokenX: PublicKey;
  let goodUserTokenY: PublicKey;
  let badUserTokenX: PublicKey;
  let attacker: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = payer.publicKey;
    attacker = Keypair.generate();

    await fundAccount(
      provider,
      stealth.publicKey,
      0.05 * anchor.web3.LAMPORTS_PER_SOL,
    );

    // ── Step 1: dlmm_init_position ───────────────────────────────────
    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;

    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    const initDisc = await anchorDiscriminator("dlmm_init_position");
    const initArgs = Buffer.alloc(8 + 32);
    initArgs.writeInt32LE(-10, 0);
    initArgs.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(initArgs, 8);

    const initDlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const initAccounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
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
    goodUserTokenX = await createAccount(
      provider.connection,
      payer,
      NATIVE_MINT,
      exitRecipient,
      Keypair.generate(),
    );
    goodUserTokenY = await createAccount(
      provider.connection,
      payer,
      NATIVE_MINT,
      exitRecipient,
      Keypair.generate(),
    );
    badUserTokenX = await createAccount(
      provider.connection,
      payer,
      NATIVE_MINT,
      attacker.publicKey,
      Keypair.generate(),
    );
  });

  it("dlmm_init_position persisted exit_recipient on PoolAuthority", async () => {
    const paData = await provider.connection.getAccountInfo(poolAuthority);
    expect(paData).to.not.be.null;
    const data = paData!.data;
    // Layout: disc(8) + stealth(32) + exit_recipient(32) + pool_ref_tag(1) + lb_pair(32) + position(32) + bump(1)
    const stealthPubkey = new PublicKey(data.subarray(8, 40));
    const exitRecipientParsed = new PublicKey(data.subarray(40, 72));
    const storedLbPair = new PublicKey(data.subarray(73, 105));
    const storedPosition = new PublicKey(data.subarray(105, 137));
    const poolRefTag = data[72];

    expect(poolRefTag).to.equal(0); // Dlmm
    expect(storedLbPair.equals(LB_PAIR)).to.be.true;
    expect(storedPosition.equals(positionPubkey)).to.be.true;
    expect(stealthPubkey.equals(stealth.publicKey)).to.be.true;
    expect(exitRecipientParsed.equals(exitRecipient)).to.be.true;
  });

  it("dlmm_claim_fees rejects user_token_x not owned by exit_recipient", async () => {
    const placeholder = Keypair.generate().publicKey;

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },              // 0 lb_pair
      { pubkey: positionPubkey, isSigner: false, isWritable: true },       // 1 position
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 2 bin_array_lower
      { pubkey: placeholder, isSigner: false, isWritable: true },          // 3 bin_array_upper
      { pubkey: poolAuthority, isSigner: false, isWritable: false },       // 4 sender (re-pinned)
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
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    const ix = new TransactionInstruction({
      programId,
      keys: accounts,
      data: await anchorDiscriminator("dlmm_claim_fees"),
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

  function buildWithdrawCloseIx(opts: {
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    rentReceiver: PublicKey;
    discriminator: Buffer;
  }): TransactionInstruction {
    const placeholder = Keypair.generate().publicKey;

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },        // 0 position
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },               // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },       // 2 bitmap_ext
      { pubkey: opts.userTokenX, isSigner: false, isWritable: true },       // 3 user_token_x
      { pubkey: opts.userTokenY, isSigner: false, isWritable: true },       // 4 user_token_y
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 5 reserve_x
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 6 reserve_y
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },          // 7 token_x_mint
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },          // 8 token_y_mint
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 9 bin_array_lower
      { pubkey: placeholder, isSigner: false, isWritable: true },           // 10 bin_array_upper
      { pubkey: poolAuthority, isSigner: false, isWritable: false },        // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 13 token_y_program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },      // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },      // 15 program
      { pubkey: opts.rentReceiver, isSigner: false, isWritable: true },     // 16 rent_receiver
    ];

    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    const args = Buffer.alloc(10);
    args.writeInt32LE(-10, 0);
    args.writeInt32LE(10, 4);
    args.writeUInt16LE(10000, 8);

    return new TransactionInstruction({
      programId,
      keys: accounts,
      data: Buffer.concat([opts.discriminator, args]),
    });
  }

  it("dlmm_withdraw_close rejects user_token_x not owned by exit_recipient", async () => {
    const disc = await anchorDiscriminator("dlmm_withdraw_close");
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

  it("dlmm_withdraw_close rejects rent_receiver != exit_recipient", async () => {
    const disc = await anchorDiscriminator("dlmm_withdraw_close");
    const ix = buildWithdrawCloseIx({
      userTokenX: goodUserTokenX,
      userTokenY: goodUserTokenY,
      rentReceiver: attacker.publicKey,
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
