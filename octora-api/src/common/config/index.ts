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
  DlmmProgramConfig,
  ResendConfig,
  MixerConfig,
  RateLimiterRuntimeConfig,
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
    outboundHttp: {
      breakerFailureThreshold:
        parseInteger(process.env.OCTORA_HTTP_BREAKER_FAILURE_THRESHOLD) ?? 5,
      breakerWindowMs: parseInteger(process.env.OCTORA_HTTP_BREAKER_WINDOW_MS) ?? 30_000,
      breakerCooldownMs: parseInteger(process.env.OCTORA_HTTP_BREAKER_COOLDOWN_MS) ?? 30_000,
      meteoraPoolCacheTtlMs:
        parseInteger(process.env.OCTORA_METEORA_POOL_CACHE_TTL_MS) ?? 5_000,
      meteoraPoolCacheMax: parseInteger(process.env.OCTORA_METEORA_POOL_CACHE_MAX) ?? 512,
    },
    dbPool: loadDbPoolConfig(),
    rateLimiter: loadRateLimiterConfig(),
    mixerRelayer: loadMixerRelayerConfig(),
    betaCaps: {
      maxPositionSol: parseFloat(process.env.BETA_MAX_POSITION_SOL) ?? 2.5,
      maxGlobalTvlSol: parseFloat(process.env.BETA_MAX_GLOBAL_TVL_SOL) ?? 125,
      maxPositionsPerWallet: parseInteger(process.env.BETA_MAX_POSITIONS_PER_WALLET) ?? 5,
    },
    adminApiToken: process.env.OCTORA_ADMIN_API_TOKEN?.trim() || null,
    sentryDsn: process.env.SENTRY_DSN?.trim() || null,
    otelExporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null,
    otelServiceName: process.env.OTEL_SERVICE_NAME?.trim() || 'octora-api',
    recoveryWorkerEnabled: process.env.OCTORA_RECOVERY_WORKER_ENABLED !== 'false',
    // Per-network RPC for on-chain DLMM reads. Each network must resolve to
    // an RPC that actually hosts that cluster — falling back to
    // `executorRpcUrl` here was a footgun, because the executor RPC is
    // typically localnet/devnet during dev. A mainnet bin read against a
    // localnet RPC returns "Invalid account discriminator" for every
    // mainnet pool, so the frontend ends up in MODELED fallback for every
    // pool in the discovery list. Only `localnet` is allowed to share with
    // `solanaRpcUrl`, since both intentionally point at the same dev
    // validator.
    dlmmRpcUrls: {
      mainnet:
        process.env.OCTORA_DLMM_RPC_URL_MAINNET?.trim() ||
        'https://api.mainnet-beta.solana.com',
      devnet:
        process.env.OCTORA_DLMM_RPC_URL_DEVNET?.trim() ||
        'https://api.devnet.solana.com',
      localnet:
        process.env.OCTORA_DLMM_RPC_URL_LOCALNET?.trim() ||
        solanaRpcUrl ||
        'http://127.0.0.1:8899',
    },
    dlmm: {
      programId:
        process.env.OCTORA_DLMM_PROGRAM_ID?.trim() ||
        'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      eventAuthority:
        process.env.OCTORA_DLMM_EVENT_AUTHORITY?.trim() ||
        'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6',
      presetParameter:
        process.env.OCTORA_DLMM_PRESET_PARAMETER?.trim() ||
        'BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63',
      binStep: parseInteger(process.env.OCTORA_DLMM_BIN_STEP) ?? 10,
      baseFactor: parseInteger(process.env.OCTORA_DLMM_BASE_FACTOR) ?? 10_000,
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

/**
 * Resolve the rate-limiter runtime config. `RATE_LIMITER` selects the
 * backend; when set to `redis`, `REDIS_URL` becomes mandatory. The
 * downstream factory (common/ratelimit) also asserts this — keeping
 * the check here too means we fail at boot rather than at first request.
 */
function loadRateLimiterConfig(): { backend: 'memory' | 'redis'; redisUrl: string | null } {
  const raw = process.env.RATE_LIMITER?.trim().toLowerCase() || 'memory'
  if (raw !== 'memory' && raw !== 'redis') {
    throw new Error(`RATE_LIMITER must be 'memory' or 'redis' (got '${raw}').`)
  }
  const redisUrl = process.env.REDIS_URL?.trim() || null
  if (raw === 'redis' && !redisUrl) {
    throw new Error("RATE_LIMITER=redis requires REDIS_URL to be set.")
  }
  return { backend: raw, redisUrl }
}

/**
 * Resolve Postgres pool tuning. Defaults mirror pre-tuning behavior so a
 * deployment without these envs is byte-equivalent. `OCTORA_DB_POOL_*`
 * sizes the `pg.Pool`; `OCTORA_DB_STATEMENT_TIMEOUT_MS` is applied as a
 * session-level `SET statement_timeout` on every new connection.
 *
 * `OCTORA_DB_PGBOUNCER_MODE` is informational — it documents the upstream
 * pooler's mode so deployments can audit it against the Prisma adapter
 * settings (transaction-mode forbids named prepared statements).
 */
function loadDbPoolConfig(): {
  max: number
  min: number
  idleTimeoutMs: number
  statementTimeoutMs: number
  pgbouncerMode: 'transaction' | 'session' | 'none'
} {
  const mode = (process.env.OCTORA_DB_PGBOUNCER_MODE?.trim().toLowerCase() ?? 'none') as
    | 'transaction'
    | 'session'
    | 'none'
  if (mode !== 'transaction' && mode !== 'session' && mode !== 'none') {
    throw new Error(
      `OCTORA_DB_PGBOUNCER_MODE must be 'transaction', 'session' or 'none' (got '${mode}').`,
    )
  }
  return {
    max: parseInteger(process.env.OCTORA_DB_POOL_MAX) ?? 10,
    min: parseInteger(process.env.OCTORA_DB_POOL_MIN) ?? 0,
    idleTimeoutMs: parseInteger(process.env.OCTORA_DB_POOL_IDLE_MS) ?? 10_000,
    statementTimeoutMs: parseInteger(process.env.OCTORA_DB_STATEMENT_TIMEOUT_MS) ?? 0,
    pgbouncerMode: mode,
  }
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
