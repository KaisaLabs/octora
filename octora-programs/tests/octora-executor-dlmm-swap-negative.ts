/**
 * `dlmm_swap` negative-path test suite.
 *
 * Covers the executor's pre-flight validations — these fire BEFORE the CPI
 * to DLMM, so they don't need a real LB pair with liquidity. Slippage
 * (post-check) is exercised in `octora-executor-dlmm-swap.ts`.
 *
 * Error code map (from ExecutorError enum, see programs/octora-executor/src/errors.rs):
 *   6000 = DlmmProgramMismatch
 *   6003 = LbPairMismatch
 *   6005 = StealthMismatch
 *   6006 = ExitRecipientMismatch  (reused for token_account_owner mismatch)
 *   6008 = InvalidTokenProgram
 *   6010 = DlmmEventAuthorityMismatch
 *   6012 = ArgOutOfRange
 *   6013 = AccountsTooShort
 *   6022 = TokenMintMismatch
 *   6023 = Paused
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────
const CONFIG_SEED = Buffer.from("config");
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);
const FAKE_LB_PAIR = new PublicKey(
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
);

const ERR_DLMM_PROGRAM_MISMATCH = 6000;
const ERR_LBPAIR_MISMATCH = 6003;
const ERR_STEALTH_MISMATCH = 6005;
const ERR_EXIT_RECIPIENT = 6006;
const ERR_INVALID_TOKEN_PROGRAM = 6008;
const ERR_EVENT_AUTHORITY = 6010;
const ERR_ARG_OUT_OF_RANGE = 6012;
const ERR_TOKEN_MINT_MISMATCH = 6022;
const ERR_PAUSED = 6023;

// ─── Helpers ───────────────────────────────────────────────────────────
async function anchorDiscriminator(name: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

async function fundLamports(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number,
) {
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: to,
        lamports,
      }),
    ),
  );
}

function extractErrorCode(err: any): number | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Code: ([A-Za-z]+)/);
    if (m && err?.error?.errorCode?.number) return err.error.errorCode.number;
    const n = line.match(/Error Number:\s*(\d+)/);
    if (n) return parseInt(n[1], 10);
  }
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/0x([0-9a-fA-F]+)/);
  if (m2) return parseInt(m2[1], 16);
  return null;
}

function encodeSwapArgs(amountIn: bigint, minOut: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(amountIn, 0);
  buf.writeBigUInt64LE(minOut, 8);
  return buf;
}

// Build the 16 fixed account-list slots (excluding bin arrays). Tests can
// substitute individual slots to exercise each negative path.
type SwapFixedAccounts = {
  lbPair: PublicKey;
  binArrayBitmapExtension: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  userTokenIn: PublicKey;
  userTokenOut: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  oracle: PublicKey;
  hostFeeIn: PublicKey;
  user: PublicKey;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
  eventAuthority: PublicKey;
  dlmmProgramRemaining: PublicKey;
  binArray0: PublicKey;
};

function buildSwapMetas(a: SwapFixedAccounts): AccountMeta[] {
  // Order MUST match programs/octora-executor/src/instructions/dlmm/swap.rs
  // remaining-account layout.
  return [
    { pubkey: a.lbPair, isSigner: false, isWritable: true },
    { pubkey: a.binArrayBitmapExtension, isSigner: false, isWritable: true },
    { pubkey: a.reserveX, isSigner: false, isWritable: true },
    { pubkey: a.reserveY, isSigner: false, isWritable: true },
    { pubkey: a.userTokenIn, isSigner: false, isWritable: true },
    { pubkey: a.userTokenOut, isSigner: false, isWritable: true },
    { pubkey: a.tokenXMint, isSigner: false, isWritable: false },
    { pubkey: a.tokenYMint, isSigner: false, isWritable: false },
    { pubkey: a.oracle, isSigner: false, isWritable: true },
    { pubkey: a.hostFeeIn, isSigner: false, isWritable: true },
    { pubkey: a.user, isSigner: true, isWritable: true },
    { pubkey: a.tokenXProgram, isSigner: false, isWritable: false },
    { pubkey: a.tokenYProgram, isSigner: false, isWritable: false },
    { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
    { pubkey: a.dlmmProgramRemaining, isSigner: false, isWritable: false },
    { pubkey: a.binArray0, isSigner: false, isWritable: true },
  ];
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST: dlmm_swap negative cases (executor pre-flight validation)
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_swap negative", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let configPda: PublicKey;
  let stealth: Keypair;
  let mintX: PublicKey;
  let mintY: PublicKey;
  let stealthAtaX: PublicKey;
  let stealthAtaY: PublicKey;
  let attackerAtaX: PublicKey;
  let baseAccounts: SwapFixedAccounts;

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);

    stealth = Keypair.generate();
    await fundLamports(provider, stealth.publicKey, 1e9);

    const payer = provider.wallet as anchor.Wallet;
    mintX = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );
    mintY = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );

    stealthAtaX = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mintX,
        stealth.publicKey,
      )
    ).address;
    stealthAtaY = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mintY,
        stealth.publicKey,
      )
    ).address;

    const attacker = Keypair.generate();
    attackerAtaX = await createAccount(
      provider.connection,
      payer.payer,
      mintX,
      attacker.publicKey,
      Keypair.generate(),
    );

    baseAccounts = {
      lbPair: FAKE_LB_PAIR,
      binArrayBitmapExtension: DLMM_PROGRAM_ID,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      userTokenIn: stealthAtaX,
      userTokenOut: stealthAtaY,
      tokenXMint: mintX,
      tokenYMint: mintY,
      oracle: Keypair.generate().publicKey,
      hostFeeIn: DLMM_PROGRAM_ID,
      user: stealth.publicKey,
      tokenXProgram: TOKEN_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      dlmmProgramRemaining: DLMM_PROGRAM_ID,
      binArray0: Keypair.generate().publicKey,
    };
  });

  async function buildAndSend(
    accounts: SwapFixedAccounts,
    amountIn: bigint,
    minOut: bigint,
    options: {
      lbPairOverride?: PublicKey;
      dlmmProgramOverride?: PublicKey;
    } = {},
  ): Promise<number | null> {
    const disc = await anchorDiscriminator("dlmm_swap");
    const args = encodeSwapArgs(amountIn, minOut);

    const fixedAccounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      {
        pubkey: options.dlmmProgramOverride ?? DLMM_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: options.lbPairOverride ?? accounts.lbPair,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: configPda, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({
      programId,
      keys: [...fixedAccounts, ...buildSwapMetas(accounts)],
      data: Buffer.concat([disc, args]),
    });

    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth]);
      return null;
    } catch (e) {
      return extractErrorCode(e);
    }
  }

  it("rejects amount_in == 0 with ArgOutOfRange", async () => {
    const code = await buildAndSend(baseAccounts, 0n, 0n);
    expect(code).to.equal(ERR_ARG_OUT_OF_RANGE);
  });

  it("rejects wrong DLMM program ID with DlmmProgramMismatch", async () => {
    const code = await buildAndSend(baseAccounts, 100n, 0n, {
      dlmmProgramOverride: Keypair.generate().publicKey,
    });
    expect(code).to.equal(ERR_DLMM_PROGRAM_MISMATCH);
  });

  it("rejects lb_pair forwarded != lb_pair in account struct", async () => {
    const code = await buildAndSend(
      { ...baseAccounts, lbPair: Keypair.generate().publicKey },
      100n,
      0n,
      { lbPairOverride: FAKE_LB_PAIR },
    );
    expect(code).to.equal(ERR_LBPAIR_MISMATCH);
  });

  it("rejects user_token_in not owned by stealth", async () => {
    const code = await buildAndSend(
      { ...baseAccounts, userTokenIn: attackerAtaX },
      100n,
      0n,
    );
    expect(code).to.equal(ERR_EXIT_RECIPIENT);
  });

  it("rejects user account != stealth signer", async () => {
    const code = await buildAndSend(
      { ...baseAccounts, user: Keypair.generate().publicKey },
      100n,
      0n,
    );
    expect(code).to.equal(ERR_STEALTH_MISMATCH);
  });

  it("rejects mint mismatch (user_token_out mint not in {mintX, mintY})", async () => {
    // Create a token account for a third unrelated mint.
    const payer = provider.wallet as anchor.Wallet;
    const unrelatedMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );
    const unrelatedAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        unrelatedMint,
        stealth.publicKey,
      )
    ).address;

    const code = await buildAndSend(
      { ...baseAccounts, userTokenOut: unrelatedAta },
      100n,
      0n,
    );
    expect(code).to.equal(ERR_TOKEN_MINT_MISMATCH);
  });

  it("rejects non-SPL token program", async () => {
    const code = await buildAndSend(
      { ...baseAccounts, tokenXProgram: Keypair.generate().publicKey },
      100n,
      0n,
    );
    expect(code).to.equal(ERR_INVALID_TOKEN_PROGRAM);
  });

  it("rejects wrong DLMM event authority", async () => {
    const code = await buildAndSend(
      { ...baseAccounts, eventAuthority: Keypair.generate().publicKey },
      100n,
      0n,
    );
    expect(code).to.equal(ERR_EVENT_AUTHORITY);
  });

  // Note: Paused-config check is exercised in `octora-executor-dlmm-swap.ts`
  // because it requires flipping Config.paused via set_paused — which needs
  // the test admin authority and the existing admin test infrastructure.
});
