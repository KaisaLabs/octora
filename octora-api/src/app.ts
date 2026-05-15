import Fastify, { type preHandlerHookHandler } from 'fastify'
import cors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'

import { createPrismaClient } from '#common/db/client'
import { loadConfig } from '#common/config'
import { runHealthCheck } from '#common/health'
import { pingDatabase } from '#common/db/health'
import { collectMetrics } from '#common/metrics'
import { createHttpTimingRegistry, registerHttpTiming } from '#common/http/timing'
import { buildLoggerOptions, genReqId, initSentry, initTelemetry } from '#common/observability'
import { registerErrorHandler } from '#common/errors'
import { requireBetaAccess, requireWalletSignature } from '#common/auth'
import { createRateLimiterFactoryFromConfig, type RateLimiterFactory } from '#common/ratelimit'
import { LiveSolanaChain } from '#common/solana/live-chain'
import type { SolanaChain } from '#common/solana/chain'
import { createPrismaPositionRepository, type PositionRepository } from '#modules/positions/position.repository'
import { createPrismaActivityRepository, type ActivityRepository } from '#modules/positions/activity.repository'
import { createPrismaReconciliationRepository, type ReconciliationRepository } from '#modules/indexer/indexer.repository'
import { registerPositionRoutes } from '#modules/positions/position.routes'
import { registerDlmmRoutes } from '#modules/dlmm/dlmm.routes'
import { registerPricesRoutes } from '#modules/prices/prices.routes'
import { registerTokensRoutes } from '#modules/tokens/tokens.routes'
import { createPrismaWaitlistRepository, type WaitlistRepository } from '#modules/waitlist/waitlist.repository'
import { registerWaitlistRoutes } from '#modules/waitlist/waitlist.routes'
import { registerMixerRoutes } from '#modules/mixer/mixer.routes'
import { MixerRegistry } from '#modules/mixer/mixer.registry'
import { registerExecutorRoutes } from '#modules/executor/executor.routes'
import { registerDepositsRoutes } from '#modules/deposits'
import { registerRelayerRoutes } from '#modules/relayer'
import { createPrismaRootSeenRepository } from '#modules/relayer/root-seen.repository'
import { registerAuthRoutes } from '#modules/auth/auth.routes'
import { createPrismaAuthRepository } from '#modules/auth/auth.repository'
import { registerAdminRoutes } from '#modules/admin/admin.routes'
import { createMeteoraExecutorFromConfig } from '#modules/execution/clients'
import { configureDlmmChain } from '#modules/dlmm/dlmm.chain'
import { createActivityService } from '#modules/positions/activity.service'
import { createIndexerService } from '#modules/indexer'
import { createRecoveryWorker } from '#workers/recovery.worker'
import { PublicKey } from '@solana/web3.js'

export interface AppRepositories {
  positionRepo: PositionRepository
  activityRepo: ActivityRepository
  reconciliationRepo: ReconciliationRepository
  waitlistRepo: WaitlistRepository
}

export interface CreateAppOptions {
  repos?: AppRepositories
  logger?: boolean
  /**
   * preHandler chain that authenticates a request and stamps
   * `req.wallet`. Wired into the position routes (and any future
   * wallet-gated route) so the route file itself doesn't decide
   * whether auth is real or stubbed.
   *
   * Omit in production: `createApp` builds the live chain
   * (`requireWalletSignature` + `requireBetaAccess`) from the Prisma
   * client. The test harness (`test-kit/route-harness.ts`) supplies a
   * header-stamping stub so route owner-checks still run.
   */
  authPreHandlers?: preHandlerHookHandler[]
  /**
   * Optional override for the Private Position Close orchestrator
   * adapter (close/01). Production deployments don't pass this — the
   * route currently rejects in production because the Executor's
   * `buildSwapIx` is not wired yet (scoped to close/04). The test
   * harness passes an in-memory adapter so the route's HTTP contract
   * is observable end-to-end.
   */
  closeAdapter?: import("#modules/positions/position.service").CloseOrchestrationAdapter
  /**
   * close/02 — Adapter for the pre-flight `GET /close-quote` reads.
   * Same scope-down as `closeAdapter`: production deployments leave
   * this unwired (the live `getSwapQuote` + DLMM bin read wiring is
   * close/02 follow-up territory once the executor close path is
   * production-ready), tests inject an in-memory adapter.
   */
  closeQuoteAdapter?: import("#modules/positions/position.service").CloseQuoteAdapter
  /**
   * close/06 — override the chain handle used by the close-builder route
   * for fresh blockhashes. Production deployments fall back to
   * `chains.executor`; tests inject a `ScriptedChain` for determinism,
   * or pass `null` to exercise the 501 "unwired" surface explicitly.
   */
  closeBuilderChain?: import("#common/solana/chain").SolanaChain | null
}

function createPrismaRepositories(): { repos: AppRepositories; client: ReturnType<typeof createPrismaClient> } {
  const client = createPrismaClient()
  return {
    client,
    repos: {
      positionRepo: createPrismaPositionRepository(client),
      activityRepo: createPrismaActivityRepository(client),
      reconciliationRepo: createPrismaReconciliationRepository(client),
      waitlistRepo: createPrismaWaitlistRepository(client),
    },
  }
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig()
  // pluginTimeout bumped from the 10s default because registerMixerRoutes
  // awaits hydrateFromChain() during registration — paginated
  // getSignaturesForAddress + getTransaction calls regularly exceed 10s on
  // public RPC endpoints. See mixer.routes.ts for why this must stay awaited.
  // Logger: structured JSON + ISO timestamps + request id (P1-30). When
  // the caller opts out (`logger: false`), keep the off-switch — tests
  // run with logging disabled to keep output clean.
  const loggerOption = options.logger === false ? false : buildLoggerOptions()
  const app = Fastify({
    logger: loggerOption,
    genReqId,
    pluginTimeout: 120_000,
  })

  // Sentry seam (P1-30). No-op until SENTRY_DSN is set AND @sentry/node
  // is installed; see common/observability.ts for the pnpm command.
  await initSentry(app, { sentryDsn: config.sentryDsn })

  // OpenTelemetry seam (Phase 4). No-op until OTEL_EXPORTER_OTLP_ENDPOINT
  // is set AND the @opentelemetry/* packages are installed. Flushed on
  // app close so the exporter doesn't drop the tail of a session.
  const telemetryShutdown = await initTelemetry(app, {
    endpoint: config.otelExporterEndpoint,
    serviceName: config.otelServiceName,
  })
  app.addHook('onClose', telemetryShutdown)

  // Per-route latency histograms. Registered before any routes so every
  // request goes through the onRequest/onResponse hooks. Snapshot is
  // exposed via /metrics below.
  const httpTiming = createHttpTimingRegistry()
  registerHttpTiming(app, httpTiming)
  // /health needs a Prisma client to ping; we keep the same instance the
  // repos use so a connection-pool exhaustion shows up in the health probe.
  let prismaClient: ReturnType<typeof createPrismaClient> | undefined
  let repos: AppRepositories
  if (options.repos) {
    repos = options.repos
  } else {
    const built = createPrismaRepositories()
    repos = built.repos
    prismaClient = built.client
  }

  // SolanaChain bag. Each entry wraps one RPC endpoint behind the
  // `SolanaChain` seam — building them centrally here is the point:
  // `new Connection(...)` should disappear from every caller.
  //
  // - `executor` (executorRpcUrl): used by /metrics + /health on-chain
  //   probes on the executor's submitter endpoint.
  // - `cluster` (solanaRpcUrl): default cluster RPC. Reads on the
  //   deployed mixer + executor programs go through this. Keep
  //   distinct from `executor` even when they resolve to the same URL
  //   in dev; the config has a footgun note (line ~96) about
  //   cross-cluster RPC leakage.
  // - `relayer` (mixer.relayer.rpcUrl): only present when the mixer
  //   relayer is enabled. Wraps the relayer's submission endpoint
  //   (may be a privileged RPC distinct from `cluster`).
  // - `dlmm.{mainnet,devnet,localnet}`: chain-direct DLMM reads
  //   (Meteora SDK via RPC). Per-network split is load-bearing —
  //   reading a mainnet pool against a localnet RPC returns garbage
  //   discriminators (see footgun comment in config/index.ts).
  const chains: {
    executor: SolanaChain
    cluster: SolanaChain
    relayer: SolanaChain | null
    dlmm: { mainnet: SolanaChain; devnet: SolanaChain; localnet: SolanaChain }
  } = {
    executor: new LiveSolanaChain({ rpcUrl: config.executorRpcUrl }),
    cluster: new LiveSolanaChain({ rpcUrl: config.solanaRpcUrl }),
    relayer: config.mixerRelayer
      ? new LiveSolanaChain({ rpcUrl: config.mixerRelayer.rpcUrl })
      : null,
    dlmm: {
      mainnet: new LiveSolanaChain({ rpcUrl: config.dlmmRpcUrls.mainnet }),
      devnet: new LiveSolanaChain({ rpcUrl: config.dlmmRpcUrls.devnet }),
      localnet: new LiveSolanaChain({ rpcUrl: config.dlmmRpcUrls.localnet }),
    },
  }

  // Bind the per-network DLMM chain bag to `dlmm.chain.ts`'s
  // module-level registry. Done once at boot so the chain-direct
  // reads (getPoolBins, getSwapQuote, getPoolFromChain) can dispatch
  // by network without each call site having to pass the right chain
  // through.
  configureDlmmChain({ chains: chains.dlmm })

  // Build the rate-limiter factory once at boot. Memory by default;
  // Redis when `RATE_LIMITER=redis` so multiple replicas share one
  // ceiling. Routes get the factory and create their own per-family
  // limiter via `rateLimitHook`.
  const rateLimiterFactory: RateLimiterFactory = await createRateLimiterFactoryFromConfig(config)
  app.addHook('onClose', async () => {
    await rateLimiterFactory.close()
  })

  await app.register(cors, {
    origin: config.frontendUrl,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Octora API',
        description: 'Octora — Solana liquidity management API',
        version: '0.1.0',
      },
      tags: [
        { name: 'Auth', description: 'Wallet-signature challenge / nonce issuance' },
        { name: 'Positions', description: 'Position intents and lifecycle' },
        { name: 'DLMM', description: 'Meteora DLMM pool data and analytics' },
        { name: 'Prices', description: 'Realtime token USD prices via Jupiter' },
        { name: 'Waitlist', description: 'Landing page waitlist signups' },
        { name: 'Deposits', description: 'Private deposit orchestration' },
        { name: 'Relayer', description: 'Mixer relayer (Groth16-proven withdrawals)' },
        { name: 'Admin', description: 'Operator-only admin endpoints (token-gated)' },
      ],
    },
  })

  await app.register(scalarApiReference, {
    routePrefix: '/docs',
  })

  // Global error handler. `ApiError` → `{ error: { code, message, details? } }`
  // with the subclass's statusCode; Fastify validation errors → 422; anything
  // else → 500 with the original message redacted and the full error logged.
  // See common/errors/error-handler.ts.
  registerErrorHandler(app)

  // Pick the MeteoraExecutor implementation up-front so we can hand the
  // same instance to every position route. Default = mock; switching to
  // the on-chain executor is a single env flag (OCTORA_USE_ONCHAIN_EXECUTOR).
  const meteoraExecutor = createMeteoraExecutorFromConfig(config, chains.executor)

  // Real liveness/readiness probe. Returns 503 on any failed dependency so
  // load balancers and uptime monitors actually catch DB / RPC / relayer /
  // mixer-paused outages instead of routing traffic into a broken backend.
  // Falls back to a minimal alive-only probe when the app is hosting
  // injected repos without a Prisma client (test harness path).
  app.get('/health', async (_req, reply) => {
    if (!prismaClient) {
      return reply.send({ status: 'ok', mode: 'minimal' })
    }
    const report = await runHealthCheck(() => pingDatabase(prismaClient!), chains.executor, config)
    const code = report.status === 'ok' ? 200 : 503
    return reply.code(code).send(report)
  })

  // Metrics endpoint. JSON snapshot of mixer TVL, position state
  // distribution, and process uptime — meant to be polled by external
  // monitoring (UptimeRobot, Datadog, Grafana JSON datasource). Returns
  // the same minimal shape in test mode so probes don't 500 there.
  app.get('/metrics', async (_req, reply) => {
    if (!prismaClient) {
      return reply.send({
        collectedAt: new Date().toISOString(),
        mode: 'minimal',
        http: httpTiming.snapshot(),
      })
    }
    try {
      const snapshot = await collectMetrics(repos.positionRepo, config, chains.executor, httpTiming)
      return reply.send(snapshot)
    } catch (err) {
      app.log.error({ err }, '/metrics: collection failed')
      return reply.code(503).send({
        error: 'MetricsUnavailable',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  // Build the auth chain. Prefer an explicitly-supplied stub (test
  // harness path); otherwise build the live wallet-signature + beta-
  // access gate from the Prisma client. Failing here at boot is
  // intentional — running position routes with no auth in production
  // would be a foot-cannon.
  const authRepo = prismaClient ? createPrismaAuthRepository(prismaClient) : null
  const authPreHandlers: preHandlerHookHandler[] = options.authPreHandlers
    ?? (authRepo
      ? [requireWalletSignature(authRepo), requireBetaAccess(authRepo)]
      : (() => {
        throw new Error(
          'createApp: no authPreHandlers supplied and no Prisma client available. '
          + 'Production wiring should pass a live PrismaClient; tests should call '
          + 'createTestApp() from #test-kit/route-harness.',
        )
      })())

  // Wallet-signature auth + admin routes. Both depend on the live
  // Prisma client; they degrade to no-op when the app is built with
  // injected repos and no client (test harness).
  if (authRepo) {
    await app.register(registerAuthRoutes, { authRepo, rateLimiterFactory })
    await app.register(registerAdminRoutes, {
      waitlistRepo: repos.waitlistRepo,
      adminApiToken: config.adminApiToken,
    })
  }

  app.register(registerPositionRoutes, {
    ...repos,
    meteoraExecutor,
    betaCaps: config.betaCaps,
    authPreHandlers,
    rateLimiterFactory,
    closeAdapter: options.closeAdapter,
    closeQuoteAdapter: options.closeQuoteAdapter,
    // close/06 — share the executor chain for the close-builder route.
    // The builder only needs a fresh blockhash + tx serialization, so
    // we reuse the executor RPC handle (same cluster the DLMM ix would
    // land on). Tests can swap a scripted chain or pass `null` to
    // exercise the 501 "unwired" surface explicitly.
    closeBuilderChain:
      options.closeBuilderChain === null
        ? undefined
        : (options.closeBuilderChain ?? chains.executor),
  })
  app.register(registerDlmmRoutes)
  app.register(registerPricesRoutes)
  app.register(registerTokensRoutes)
  app.register(registerWaitlistRoutes, { waitlistRepo: repos.waitlistRepo })
  // Build the MixerRegistry once and share it across routes so the
  // anonymity-set tracker (spent-nullifier set + deposit count) stays
  // consistent: the mixer routes hydrate it from chain at startup, and
  // the relayer route bumps it on every successful withdrawal.
  const mixerRegistry = new MixerRegistry({
    chain: chains.cluster,
    programId: new PublicKey(config.mixerProgramId),
    denominations: config.mixerDenominations,
  })

  app.register(registerMixerRoutes, {
    mixerProgramId: config.mixerProgramId,
    mixerDenominations: config.mixerDenominations,
    registry: mixerRegistry,
    rateLimiterFactory,
    chain: chains.cluster,
  })
  app.register(registerExecutorRoutes, {
    executorProgramId: config.executorProgramId,
    relayerKeypairPath: config.executorRelayerKeypairPath,
    chain: chains.cluster,
  })
  app.register(registerDepositsRoutes, { mixerDenominations: config.mixerDenominations })

  // Mixer relayer is opt-in: only mount when explicitly enabled, since it
  // holds a hot wallet. Driven by OCTORA_MIXER_RELAYER_ENABLED=true plus the
  // other OCTORA_MIXER_RELAYER_* env vars (see common/config.ts).
  if (config.mixerRelayer) {
    const rootSeenRepo = prismaClient ? createPrismaRootSeenRepository(prismaClient) : null
    // chains.relayer is non-null whenever config.mixerRelayer is set
    // (they share the same gate). Assert to drop the union.
    await registerRelayerRoutes(
      app,
      config.mixerRelayer,
      chains.relayer!,
      rootSeenRepo,
      mixerRegistry,
      rateLimiterFactory,
    )
  }

  // Recovery worker (P1-29). Polls every 30s to advance stuck positions
  // and capture newly-failed ones. Started only with a real Prisma
  // client — test harness skips it because there's nothing to recover.
  // Disable explicitly via OCTORA_RECOVERY_WORKER_ENABLED=false to keep
  // a deploy quiet during incident response.
  if (prismaClient && config.recoveryWorkerEnabled) {
    const worker = createRecoveryWorker({
      positionRepo: repos.positionRepo,
      activityService: createActivityService(repos.activityRepo),
      positionIndexer: createIndexerService({ store: repos.reconciliationRepo }),
      chain: chains.executor,
      reconciliationRepo: repos.reconciliationRepo,
      log: (msg, ctx) => app.log.info(ctx ?? {}, msg),
    })
    worker.start()
    app.addHook('onClose', async () => worker.stop())
  }

  return app
}
