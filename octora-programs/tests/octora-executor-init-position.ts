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

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");

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

function derivePoolAuthority(
  programId: PublicKey,
  stealth: PublicKey,
  lbPair: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), lbPair.toBuffer()],
    programId,
  );
}

/**
 * Anchor-style discriminator: `sha256("global:<ix>")[..8]`.
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

describe("octora-executor :: dlmm_init_position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  it("creates PoolAuthority PDA and a DLMM-owned position via CPI", async () => {
    const stealth = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 1_000_000_000);

    const positionKp = Keypair.generate();
    const exitRecipient = Keypair.generate().publicKey;

    const [poolAuthority] = derivePoolAuthority(
      programId,
      stealth.publicKey,
      LB_PAIR,
    );

    // DLMM initialize_position accounts (see program comments for ordering)
    const remainingAccounts: AccountMeta[] = [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    // Args: lower_bin_id (i32 LE) + width (i32 LE) + exit_recipient (32 bytes) = 40 bytes
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-1165, 0); // ~$10.56 on SOL/USDC
    args.writeInt32LE(1200, 4);
    exitRecipient.toBuffer().copy(args, 8);

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },     // stealth
      { pubkey: poolAuthority, isSigner: false, isWritable: true },        // pool_authority
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },             // lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },     // dlmm_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ...remainingAccounts,
    ];

    const ix = new TransactionInstruction({
      programId,
      keys,
      data: Buffer.concat([disc, args]),
    });

    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ix,
      ),
      [stealth, positionKp],
    );

    // Verify the PoolAuthority account was created and has the right fields.
    // The program uses `PoolRef::Dlmm` discriminant internally, so fields
    // should be serialized as: stealth_pubkey (32) + exit_recipient (32) + 
    // pool_ref (1 tag + 32 lb_pair + 32 position) + bump (1)
    const connection2 = provider.connection;
    const paData = await connection2.getAccountInfo(poolAuthority);
    expect(paData).to.not.be.null;

    // The data layout is Anchor discriminator (8 bytes) + struct fields
    const data = paData!.data;
    // Skip Anchor discriminator (first 8 bytes)
    const stealthPubkey = new PublicKey(data.subarray(8, 40));
    const exitRecipientParsed = new PublicKey(data.subarray(40, 72));
    const poolRefTag = data[72]; // 0 = Dlmm
    const storedLbPair = new PublicKey(data.subarray(73, 105));
    const storedPosition = new PublicKey(data.subarray(105, 137));

    expect(stealthPubkey.equals(stealth.publicKey)).to.be.true;
    expect(exitRecipientParsed.equals(exitRecipient)).to.be.true;
    expect(poolRefTag).to.equal(0); // Dlmm variant
    expect(storedLbPair.equals(LB_PAIR)).to.be.true;
    expect(storedPosition.equals(positionKp.publicKey)).to.be.true;
  });

  it("rejects a second init for the same stealth + lb_pair (PDA already in use)", async () => {
    const stealth = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 1_000_000_000);

    const positionKp = Keypair.generate();
    const exitRecipient = Keypair.generate().publicKey;

    const [poolAuthority] = derivePoolAuthority(
      programId,
      stealth.publicKey,
      LB_PAIR,
    );

    const remainingAccounts: AccountMeta[] = [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-1165, 0);
    args.writeInt32LE(1200, 4);
    exitRecipient.toBuffer().copy(args, 8);

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ];

    const ix = new TransactionInstruction({
      programId,
      keys,
      data: Buffer.concat([await anchorDiscriminator("dlmm_init_position"), args]),
    });

    // First init should succeed
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ix,
      ),
      [stealth, positionKp],
    );

    // Second init with same stealth + lb_pair should fail (PDA already exists)
    const positionKp2 = Keypair.generate();
    const remainingAccounts2: AccountMeta[] = [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp2.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const args2 = Buffer.alloc(8 + 32);
    args2.writeInt32LE(-1165, 0);
    args2.writeInt32LE(1200, 4);
    exitRecipient.toBuffer().copy(args2, 8);

    const keys2: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts2,
    ];

    const ix2 = new TransactionInstruction({
      programId,
      keys: keys2,
      data: Buffer.concat([await anchorDiscriminator("dlmm_init_position"), args2]),
    });

    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ix2,
        ),
        [stealth, positionKp2],
      );
      expect.fail("Expected init to fail");
    } catch (err: any) {
      const log = err.logs?.join("\n") ?? "";
      expect(log).to.include("already in use");
    }
  });
});
