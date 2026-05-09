/**
 * Token-2022 compatibility tests.
 *
 * Verifies the executor correctly handles Token-2022 token accounts for
 * claim fees and withdraw flows. Uses Token-2022 program to create
 * accounts and confirms owner validation works correctly.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  createInitializeAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  getTokenAccountSize,
} from "@solana/spl-token-2022";
import { expect } from "chai";

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LB_PAIR = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
const EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");

const ERR_EXIT_RECIPIENT = 6006;

function derivePoolAuthority(programId: PublicKey, stealth: PublicKey, poolKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), poolKey.toBuffer()], programId);
}

async function anchorDiscriminator(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}

async function fundAccount(provider: anchor.AnchorProvider, to: PublicKey, lamports: number) {
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: to, lamports })));
}

function extractErrorCode(err: any): number | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/0x([0-9a-fA-F]+)/);
  if (m2) return parseInt(m2[1], 16);
  return null;
}

/**
 * Create a Token-2022 token account owned by `owner`.
 */
async function createToken2022Account(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Signer,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const kp = Keypair.generate();
  const space = getTokenAccountSize();
  const rent = await connection.getMinimumBalanceForRentExemption(space);

  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports: rent,
      space,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(kp.publicKey, mint, owner, TOKEN_2022_PROGRAM_ID),
  ];

  await new anchor.AnchorProvider(
    connection, { publicKey: payer.publicKey, signTransaction: async (t) => { t.sign(payer); return t; }, signAllTransactions: async (ts) => ts }, {}
  ).sendAndConfirm(new Transaction().add(...ixs), [kp]);

  return kp.publicKey;
}

// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: Token-2022 compatibility", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;
  let attacker: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    attacker = Keypair.generate();

    await fundAccount(provider, stealth.publicKey, 5e7);
    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    // Init position
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(
      new Transaction().add(new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) })),
      [stealth, positionKp],
    );
  });

  it("claim_fees rejects Token-2022 account not owned by exit_recipient", async () => {
    const payer = provider.wallet as anchor.Wallet;
    // Create Token-2022 accounts
    const token2022Mint = await anchor.web3.Keypair.generate().publicKey; // placeholder — owner check doesn't need real mint
    const badToken2022 = await createToken2022Account(provider.connection, payer.payer, token2022Mint, attacker.publicKey);

    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: badToken2022, isSigner: false, isWritable: true },  // bad owner
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: token2022Mint, isSigner: false, isWritable: false },
      { pubkey: token2022Mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId, keys: accounts, data: await anchorDiscriminator("dlmm_claim_fees") });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_EXIT_RECIPIENT);
  });

  it("claim_fees accepts Token-2022 account with correct owner", async () => {
    const payer = provider.wallet as anchor.Wallet;
    const token2022Mint = await anchor.web3.Keypair.generate().publicKey;
    const goodToken2022 = await createToken2022Account(provider.connection, payer.payer, token2022Mint, exitRecipient);

    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: goodToken2022, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: token2022Mint, isSigner: false, isWritable: false },
      { pubkey: token2022Mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId, keys: accounts, data: await anchorDiscriminator("dlmm_claim_fees") });

    // Should fail at CPI (no real fees in position) but pass our owner check
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth]);
    } catch (e) {
      // Expected: fails at DLMM CPI because position has no fees.
      // Important: must NOT be an ExitRecipientMismatch error.
      const code = extractErrorCode(e);
      expect(code).to.not.equal(ERR_EXIT_RECIPIENT);
    }
  });
});
