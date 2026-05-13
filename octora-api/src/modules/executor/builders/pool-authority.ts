import { PublicKey } from "@solana/web3.js";

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");

/**
 * PoolAuthority PDA seeds match the program's `dlmm/*` handlers:
 *   [POOL_AUTHORITY_SEED, stealth.key(), lb_pair.key()]
 */
export function derivePoolAuthorityPda(
  programId: PublicKey,
  stealth: PublicKey,
  lbPair: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), lbPair.toBuffer()],
    programId,
  );
}
