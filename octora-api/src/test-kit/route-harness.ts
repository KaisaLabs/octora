import type { FastifyRequest, preHandlerHookHandler } from "fastify";

import { createApp, type CreateAppOptions } from "#app";

import { createMemoryRepositories } from "./memory-db.js";

/**
 * Test-only default wallet. 32 chars of '1' — base58-decodes to the
 * all-zero pubkey (Solana's `SystemProgram.programId`). Always valid as
 * a `PublicKey` constructor input, so the stamper below never has to
 * recover from a bad default.
 */
const TEST_DEFAULT_WALLET = "11111111111111111111111111111111";

/**
 * Test-only preHandler. Stamps `req.wallet` from the `x-wallet-address`
 * header when present, falling back to {@link TEST_DEFAULT_WALLET}.
 *
 * Lives in `test-kit/` (not in production routes) so production code
 * does not branch on "is this a test?". Tests build their own app via
 * {@link createTestApp} and pass `[testWalletStamper]` as the auth
 * preHandler chain.
 */
export const testWalletStamper: preHandlerHookHandler = async (
  req: FastifyRequest,
) => {
  const header = req.headers["x-wallet-address"];
  const address =
    typeof header === "string" && header.trim().length > 0
      ? header.trim()
      : TEST_DEFAULT_WALLET;
  const { PublicKey } = await import("@solana/web3.js");
  let pubkey: import("@solana/web3.js").PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    pubkey = new PublicKey(TEST_DEFAULT_WALLET);
  }
  req.wallet = { address: pubkey.toBase58(), pubkey };
};

/**
 * Build a Fastify app for tests. Wires in-memory repositories, disables
 * the logger, and supplies the test wallet stamper so route owner-checks
 * still run without a real signature pipeline. Override any of those by
 * passing partial {@link CreateAppOptions}.
 */
export async function createTestApp(
  overrides: Partial<CreateAppOptions> = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  return createApp({
    repos: createMemoryRepositories(),
    authPreHandlers: [testWalletStamper],
    logger: false,
    ...overrides,
  });
}
