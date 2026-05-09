/**
 * vitest setup file — injects the env vars required by createApp() so that
 * route-level tests can boot the Fastify instance without a real .env file.
 *
 * Wired in via vitest.config.ts → test.setupFiles. Imported once per worker.
 *
 * Anything secret-looking here is a deliberately invalid placeholder; tests
 * that need real values either stub the underlying call or mark themselves
 * as integration-only.
 */

// Resend SDK throws synchronously in its constructor when the API key is
// missing, so just providing *something* is enough to let the module load
// during tests that never actually send mail.
process.env.RESEND_API_KEY ??= "test_RESEND_KEY_not_a_real_key";

// `loadConfig()` requires both program IDs. Use canonical 32-byte System
// Program-style placeholders so any code path that constructs `new PublicKey(...)`
// against them succeeds without hitting the network.
process.env.OCTORA_EXECUTOR_PROGRAM_ID ??=
  "11111111111111111111111111111111";
process.env.OCTORA_MIXER_PROGRAM_ID ??=
  "11111111111111111111111111111111";

// Default to mock executor — keeps tests offline. Anything that needs the
// on-chain executor sets OCTORA_USE_ONCHAIN_EXECUTOR=true explicitly.
process.env.OCTORA_USE_ONCHAIN_EXECUTOR ??= "false";

// FRONTEND_URL is consulted by the CORS plugin; a literal "*" keeps inject()
// behaviour identical to dev.
process.env.FRONTEND_URL ??= "*";
