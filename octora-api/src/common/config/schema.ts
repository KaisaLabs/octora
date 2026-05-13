import { z } from 'zod'

/**
 * Zod schema for the fully-resolved `AppConfig`.
 *
 * The schema describes the *shape after* defaults / parsing, not the raw
 * env strings. Env-string parsing happens in `./parsers.ts` and the
 * orchestration lives in `./index.ts` so that:
 *   - The schema is reusable by other config sources (test harness,
 *     scripts) that don't go through env vars.
 *   - Each field has one source of truth for its TypeScript type.
 *
 * Add new fields here first; the env mapping in `./index.ts` will
 * fail to typecheck until it provides the value.
 */
export const betaCapsConfigSchema = z.object({
  maxPositionSol: z.number().positive(),
  maxGlobalTvlSol: z.number().positive(),
  maxPositionsPerWallet: z.number().int().positive(),
})

export const mixerRelayerConfigSchema = z.object({
  rpcUrl: z.string().url(),
  mixerProgramId: z.string().min(1),
  poolDenomination: z.bigint().positive(),
  denominations: z.array(z.bigint().positive()).optional(),
  hotWalletSecret: z.string().min(1),
  minFeeLamports: z.bigint().nonnegative(),
  privacyDelayMs: z.number().int().nonnegative(),
})

export const dlmmRpcUrlsSchema = z.object({
  mainnet: z.string().url(),
  devnet: z.string().url(),
  localnet: z.string().url(),
})

export const resendConfigSchema = z.object({
  apiKey: z.string().min(1).nullable(),
  fromAddress: z.string().min(1),
})

export const rateLimiterConfigSchema = z.object({
  /**
   * Selected limiter backend. `memory` keeps state in-process (single
   * replica only); `redis` keeps state in Redis so multiple replicas
   * enforce one shared ceiling.
   */
  backend: z.enum(['memory', 'redis']),
  /** Required when `backend === 'redis'`. Ignored otherwise. */
  redisUrl: z.string().min(1).nullable(),
})

export const mixerConfigSchema = z.object({
  /**
   * Minimum unspent-deposit count required to permit a withdrawal build.
   * See mixer.service.ts for the privacy rationale. Default 20.
   */
  minAnonymitySet: z.number().int().nonnegative(),
})

export const appConfigSchema = z.object({
  port: z.number().int().positive(),
  nodeEnv: z.string().min(1),
  isProduction: z.boolean(),
  isTest: z.boolean(),
  logLevel: z.string().min(1),
  databaseUrl: z.string(),
  frontendUrl: z.union([z.string(), z.array(z.string())]),
  solanaRpcUrl: z.string().url(),
  useOnchainExecutor: z.boolean(),
  executorRpcUrl: z.string().url(),
  executorProgramId: z.string().min(1),
  mixerProgramId: z.string().min(1),
  executorRelayerKeypairPath: z.string().min(1),
  mixerDenomination: z.bigint().positive(),
  mixerDenominations: z.array(z.bigint().positive()).nonempty(),
  mixer: mixerConfigSchema,
  rateLimiter: rateLimiterConfigSchema,
  mixerRelayer: mixerRelayerConfigSchema.nullable(),
  betaCaps: betaCapsConfigSchema,
  adminApiToken: z.string().min(1).nullable(),
  sentryDsn: z.string().min(1).nullable(),
  recoveryWorkerEnabled: z.boolean(),
  dlmmRpcUrls: dlmmRpcUrlsSchema,
  resend: resendConfigSchema,
  /**
   * Allowed directory prefix for the relayer hot-wallet keypair file.
   * Null when the relayer is disabled. See modules/relayer/solana-client.ts.
   */
  hotWalletDir: z.string().min(1).nullable(),
})

export type AppConfig = z.infer<typeof appConfigSchema>
export type BetaCapsConfig = z.infer<typeof betaCapsConfigSchema>
export type MixerRelayerConfig = z.infer<typeof mixerRelayerConfigSchema>
export type DlmmRpcUrls = z.infer<typeof dlmmRpcUrlsSchema>
export type ResendConfig = z.infer<typeof resendConfigSchema>
export type MixerConfig = z.infer<typeof mixerConfigSchema>
export type RateLimiterRuntimeConfig = z.infer<typeof rateLimiterConfigSchema>
