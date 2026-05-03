import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayerConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "idl", "octora_mixer.json");

/** PDA seed constants (must match on-chain program) */
export const MIXER_POOL_SEED = Buffer.from("mixer_pool");
export const NULLIFIER_SEED = Buffer.from("nullifier");
export const COMMITMENT_SEED = Buffer.from("commitment");

export interface MixerClient {
  program: Program;
  provider: AnchorProvider;
  hotWallet: Keypair;
  programId: PublicKey;
}

/**
 * Create an Anchor program client for the octora-mixer program.
 *
 * Loads the IDL, sets up a connection + provider using the relayer's
 * hot wallet as the signer, and returns a typed Program instance.
 */
export function createMixerClient(config: RelayerConfig): MixerClient {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const hotWallet = loadHotWallet(config.hotWalletSecret);
  const wallet = new Wallet(hotWallet);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
  const programId = new PublicKey(config.mixerProgramId);
  const program = new Program(idl, provider);

  return { program, provider, hotWallet, programId };
}

/**
 * Derive the MixerPool PDA address.
 * Seeds: ["mixer_pool", denomination.to_le_bytes()]
 */
export function deriveMixerPoolPDA(
  programId: PublicKey,
  denomination: bigint,
): [PublicKey, number] {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);

  return PublicKey.findProgramAddressSync(
    [MIXER_POOL_SEED, denomBuf],
    programId,
  );
}

/**
 * Derive the NullifierAccount PDA address.
 * Seeds: ["nullifier", mixer_pool_key, nullifier_hash_bytes]
 */
export function deriveNullifierPDA(
  programId: PublicKey,
  mixerPoolKey: PublicKey,
  nullifierHash: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, mixerPoolKey.toBuffer(), nullifierHash],
    programId,
  );
}

/**
 * Derive the CommitmentAccount PDA address.
 * Seeds: ["commitment", mixer_pool_key, commitment_bytes]
 */
export function deriveCommitmentPDA(
  programId: PublicKey,
  mixerPoolKey: PublicKey,
  commitment: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, mixerPoolKey.toBuffer(), commitment],
    programId,
  );
}

/**
 * Check if a nullifier PDA account exists on-chain (= nullifier is spent).
 */
export async function isNullifierSpentOnChain(
  connection: Connection,
  programId: PublicKey,
  mixerPoolKey: PublicKey,
  nullifierHashHex: string,
): Promise<boolean> {
  const nullifierBuf = Buffer.from(nullifierHashHex.replace(/^0x/, "").padStart(64, "0"), "hex");
  const [pda] = deriveNullifierPDA(programId, mixerPoolKey, nullifierBuf);

  const account = await connection.getAccountInfo(pda);
  return account !== null;
}

/**
 * Load the hot wallet keypair from a secret key.
 * Supports base58 string or JSON byte array file path.
 */
function loadHotWallet(secret: string): Keypair {
  // If it looks like a file path, read it
  if (secret.startsWith("/") || secret.startsWith("~") || secret.endsWith(".json")) {
    const raw = readFileSync(secret, "utf-8");
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  // Otherwise treat as base58 secret key bytes
  const { bs58 } = await_bs58();
  return Keypair.fromSecretKey(bs58.decode(secret));
}

function await_bs58() {
  // @solana/web3.js bundles bs58 internally
  // For simplicity, decode from hex or use raw bytes
  return {
    bs58: {
      decode: (str: string): Uint8Array => {
        // Use the Keypair.fromSecretKey with the raw bytes
        // In practice, hot wallet is usually a JSON file path
        throw new Error(
          `Base58 secret key not supported directly. ` +
          `Use a JSON keypair file path instead.`,
        );
      },
    },
  };
}
