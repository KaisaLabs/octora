/**
 * Config loader — the only file allowed to read `process.env`.
 *
 * Other modules import the typed `AppConfig` (or call `loadConfig()`)
 * and access fields by name. A lint rule (eslint
 * `no-restricted-syntax` on `process.env` outside this directory)
 * enforces that boundary mechanically.
 *
 * The two layers are:
 *   - `./parsers.ts` — env-string → typed value, no defaults
 *   - `./schema.ts`  — zod shape after defaults applied
 *   - this file       — orchestration: env → parsed → schema-validated
 *
 * Throws on any malformed input. Production refuses to start without
 * an explicit `FRONTEND_URL` allowlist.
 */
import { appConfigSchema, type AppConfig, type MixerRelayerConfig } from './schema.js'
import { parseBigIntList, parseBoolean, parseCsv, parseFloat, parseInteger } from './parsers.js'

export type {
  AppConfig,
  BetaCapsConfig,
  MixerRelayerConfig,
  DlmmRpcUrls,
  ResendConfig,
  MixerConfig,
} from './schema.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'
  const isTest = nodeEnv === 'test' || process.env.VITEST === 'true'

  const solanaRpcUrl = process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com'
  const executorRpcUrl = process.env.OCTORA_EXECUTOR_RPC_URL?.trim() || 'https://api.devnet.solana.com'

  const mixerDenominations =
    parseBigIntList(process.env.MIXER_DENOMINATIONS, {
      fieldName: 'MIXER_DENOMINATIONS',
      positive: true,
    }) ?? [100_000_000n, 1_000_000_000n, 10_000_000_000n]

  const config = {
    port: parseInteger(process.env.PORT) ?? 8787,
    nodeEnv,
    isProduction,
    isTest,
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    databaseUrl: process.env.DATABASE_URL ?? '',
    frontendUrl: loadFrontendUrl(isProduction),
    solanaRpcUrl,
    useOnchainExecutor: parseBoolean(process.env.OCTORA_USE_ONCHAIN_EXECUTOR) ?? false,
    executorRpcUrl,
    executorProgramId: requireEnv('OCTORA_EXECUTOR_PROGRAM_ID'),
    mixerProgramId: requireEnv('OCTORA_MIXER_PROGRAM_ID'),
    executorRelayerKeypairPath:
      process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ?? `${process.env.HOME ?? ''}/.config/solana/id.json`,
    mixerDenomination: BigInt(process.env.MIXER_DENOMINATION ?? '1000000000'),
    mixerDenominations,
    mixer: {
      minAnonymitySet: parseInteger(process.env.MIXER_MIN_ANONYMITY_SET) ?? 20,
    },
    mixerRelayer: loadMixerRelayerConfig(),
    betaCaps: {
      maxPositionSol: parseFloat(process.env.BETA_MAX_POSITION_SOL) ?? 2.5,
      maxGlobalTvlSol: parseFloat(process.env.BETA_MAX_GLOBAL_TVL_SOL) ?? 125,
      maxPositionsPerWallet: parseInteger(process.env.BETA_MAX_POSITIONS_PER_WALLET) ?? 5,
    },
    adminApiToken: process.env.OCTORA_ADMIN_API_TOKEN?.trim() || null,
    sentryDsn: process.env.SENTRY_DSN?.trim() || null,
    recoveryWorkerEnabled: process.env.OCTORA_RECOVERY_WORKER_ENABLED !== 'false',
    dlmmRpcUrls: {
      mainnet:
        process.env.OCTORA_DLMM_RPC_URL_MAINNET?.trim() ||
        executorRpcUrl ||
        'https://api.mainnet-beta.solana.com',
      devnet:
        process.env.OCTORA_DLMM_RPC_URL_DEVNET?.trim() ||
        executorRpcUrl ||
        'https://api.devnet.solana.com',
      localnet:
        process.env.OCTORA_DLMM_RPC_URL_LOCALNET?.trim() ||
        solanaRpcUrl ||
        'http://127.0.0.1:8899',
    },
    resend: {
      apiKey: process.env.RESEND_API_KEY?.trim() || null,
      fromAddress: process.env.EMAIL_FROM?.trim() || 'Octora <onboarding@resend.dev>',
    },
    hotWalletDir: process.env.OCTORA_HOT_WALLET_DIR?.trim() || null,
  } satisfies AppConfig

  return appConfigSchema.parse(config)
}

/**
 * Parse `FRONTEND_URL` into a strict CORS allowlist.
 *
 * Production requires an explicit value and forbids `"*"` — a wildcard
 * fallback would let any origin call the API on behalf of an
 * authenticated browser. Non-production keeps a permissive default so
 * dev / local builds keep working.
 */
function loadFrontendUrl(isProduction: boolean): string | string[] {
  const raw = process.env.FRONTEND_URL?.trim() ?? ''

  if (isProduction && (raw === '' || raw === '*')) {
    throw new Error(
      'FRONTEND_URL must be set to a strict comma-separated origin allowlist ' +
        "in production (wildcard '*' is forbidden).",
    )
  }

  if (raw === '' || raw === '*') return '*'

  const origins = parseCsv(raw)
  if (!origins) return '*'
  return origins.length === 1 ? origins[0]! : origins
}

function loadMixerRelayerConfig(): MixerRelayerConfig | null {
  if (process.env.OCTORA_MIXER_RELAYER_ENABLED !== 'true') return null

  const denominations = parseBigIntList(process.env.OCTORA_MIXER_RELAYER_DENOMINATIONS, {
    fieldName: 'OCTORA_MIXER_RELAYER_DENOMINATIONS',
    positive: true,
  })
  const poolDenomination = BigInt(requireEnv('OCTORA_MIXER_POOL_DENOMINATION'))

  return {
    rpcUrl: requireEnv('OCTORA_MIXER_RELAYER_RPC_URL'),
    mixerProgramId: requireEnv('OCTORA_MIXER_PROGRAM_ID'),
    poolDenomination,
    denominations: denominations && denominations.length > 0 ? denominations : undefined,
    hotWalletSecret: requireEnv('OCTORA_MIXER_RELAYER_HOT_WALLET'),
    minFeeLamports: BigInt(requireEnv('OCTORA_MIXER_RELAYER_MIN_FEE')),
    privacyDelayMs: parseInteger(process.env.OCTORA_MIXER_PRIVACY_DELAY_MS) ?? 13_000,
  }
}
