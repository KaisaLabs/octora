import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { bigintToBytes32 } from "#modules/mixer/mixer.service";
import { loadConfig } from "#common/config";
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
  idl.address = programId.toBase58();
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
  nullifierHash: string,
): Promise<boolean> {
  const nullifierBuf = bigintToBytes32(BigInt(nullifierHash), "nullifierHash");
  const [pda] = deriveNullifierPDA(programId, mixerPoolKey, nullifierBuf);

  const account = await connection.getAccountInfo(pda);
  return account !== null;
}

/**
 * Load the hot wallet keypair from a secret.
 *
 * Supported formats:
 *   - Inline JSON byte array (e.g. `"[12,34,...,89]"`).
 *   - `file:<absolute-path>` to a JSON keypair file with mode 0600 (no
 *     group/other read or write bits set). The path is resolved against
 *     the process CWD via `path.resolve`, then required to start with
 *     OCTORA_HOT_WALLET_DIR if that env var is set (allowlist).
 *
 * Bare-string paths are intentionally NOT accepted: an attacker who can
 * influence the secret value (env override, future config endpoint) could
 * otherwise coax the relayer into reading arbitrary files. Requiring the
 * `file:` prefix forces the caller to opt in explicitly.
 *
 * Base58 secret keys are intentionally not supported here to avoid pulling
 * in a base58 dependency just for hot-wallet loading. If you need base58,
 * convert to a JSON byte array first (`solana-keygen recover` / web3.js).
 */
function loadHotWallet(secret: string): Keypair {
  const trimmed = secret.trim();

  // Inline JSON byte array
  if (trimmed.startsWith("[")) {
    return keypairFromJsonBytes(trimmed, "inline secret");
  }

  if (trimmed.startsWith("file:")) {
    const rawPath = trimmed.slice("file:".length);
    if (!rawPath) {
      throw new Error("Hot wallet `file:` prefix must be followed by a path.");
    }
    const absPath = resolvePath(rawPath);

    // Optional allowlist: if OCTORA_HOT_WALLET_DIR is set, the resolved path
    // must be inside it. Defense in depth against accidental misconfig.
    const allowlist = loadConfig().hotWalletDir;
    if (allowlist) {
      const allowedRoot = resolvePath(allowlist);
      const sep = allowedRoot.endsWith("/") ? "" : "/";
      if (absPath !== allowedRoot && !absPath.startsWith(allowedRoot + sep)) {
        throw new Error(
          `Hot wallet path ${absPath} is outside OCTORA_HOT_WALLET_DIR (${allowedRoot}).`,
        );
      }
    }

    // File mode must be 0600 (or stricter — owner-only read). Reject if
    // group/other bits or anything else allows access.
    let mode: number;
    try {
      mode = statSync(absPath).mode & 0o777;
    } catch (err) {
      throw new Error(
        `Cannot stat hot wallet file ${absPath}: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Hot wallet file ${absPath} has insecure permissions ${mode.toString(8).padStart(3, "0")}; expected 600 (chmod 600 ${absPath}).`,
      );
    }

    const raw = readFileSync(absPath, "utf-8");
    return keypairFromJsonBytes(raw, absPath);
  }

  throw new Error(
    "Unrecognised hot wallet secret format. " +
      "Provide an inline JSON byte array or a `file:<path>` reference (mode 0600).",
  );
}

function keypairFromJsonBytes(raw: string, source: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Hot wallet secret at ${source} is not valid JSON: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((b) => typeof b === "number")) {
    throw new Error(
      `Hot wallet secret at ${source} must be a JSON array of numbers (Solana keypair format).`,
    );
  }
  if (parsed.length !== 64) {
    throw new Error(
      `Hot wallet secret at ${source} must be 64 bytes, got ${parsed.length}.`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}
