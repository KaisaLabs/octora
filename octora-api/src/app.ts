import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'

import { createPrismaClient } from '#common/db/client'
import { loadConfig } from '#common/config'
import { runHealthCheck } from '#common/health'
import { collectMetrics } from '#common/metrics'
import { buildLoggerOptions, genReqId, initSentry } from '#common/observability'
import { registerErrorHandler } from '#common/errors'
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
import { registerAuthRoutes } from '#modules/auth/auth.routes'
import { registerAdminRoutes } from '#modules/admin/admin.routes'
import { createMeteoraExecutorFromConfig } from '#modules/execution/clients'
import { createActivityService } from '#modules/positions/activity.service'
import { createIndexerService } from '#modules/indexer'
import { createRecoveryWorker } from '#modules/positions/recovery-worker'
import { Connection, PublicKey } from '@solana/web3.js'

export interface AppRepositories {
  positionRepo: PositionRepository
  activityRepo: ActivityRepository
  reconciliationRepo: ReconciliationRepository
  waitlistRepo: WaitlistRepository
}

export interface CreateAppOptions {
  repos?: AppRepositories
  logger?: boolean
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
  const meteoraExecutor = createMeteoraExecutorFromConfig(config)

  // Real liveness/readiness probe. Returns 503 on any failed dependency so
  // load balancers and uptime monitors actually catch DB / RPC / relayer /
  // mixer-paused outages instead of routing traffic into a broken backend.
  // Falls back to a minimal alive-only probe when the app is hosting
  // injected repos without a Prisma client (test harness path).
  app.get('/health', async (_req, reply) => {
    if (!prismaClient) {
      return reply.send({ status: 'ok', mode: 'minimal' })
    }
    const report = await runHealthCheck(prismaClient, config)
    const code = report.status === 'ok' ? 200 : 503
    return reply.code(code).send(report)
  })

  // Metrics endpoint (P1-44). JSON snapshot of mixer TVL, position state
  // distribution, and process uptime — meant to be polled by external
  // monitoring (UptimeRobot, Datadog, Grafana JSON datasource). Returns
  // the same minimal shape in test mode so probes don't 500 there.
  app.get('/metrics', async (_req, reply) => {
    if (!prismaClient) {
      return reply.send({ collectedAt: new Date().toISOString(), mode: 'minimal' })
    }
    try {
      const snapshot = await collectMetrics(prismaClient, config)
      return reply.send(snapshot)
    } catch (err) {
      app.log.error({ err }, '/metrics: collection failed')
      return reply.code(503).send({
        error: 'MetricsUnavailable',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  // Wallet-signature auth + admin routes (P0-20, P1-25). Both depend on the
  // live Prisma client; they degrade to no-op when the app is built with
  // injected repos and no client (test harness).
  if (prismaClient) {
    await app.register(registerAuthRoutes, { prisma: prismaClient })
    await app.register(registerAdminRoutes, {
      waitlistRepo: repos.waitlistRepo,
      adminApiToken: config.adminApiToken,
    })
  }

  app.register(registerPositionRoutes, {
    ...repos,
    meteoraExecutor,
    betaCaps: config.betaCaps,
    prisma: prismaClient,
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
    rpcUrl: config.solanaRpcUrl,
    programId: new PublicKey(config.mixerProgramId),
    denominations: config.mixerDenominations,
  })

  app.register(registerMixerRoutes, {
    mixerProgramId: config.mixerProgramId,
    mixerDenominations: config.mixerDenominations,
    registry: mixerRegistry,
  })
  app.register(registerExecutorRoutes, {
    executorProgramId: config.executorProgramId,
    relayerKeypairPath: config.executorRelayerKeypairPath,
  })
  app.register(registerDepositsRoutes, { mixerDenominations: config.mixerDenominations })

  // Mixer relayer is opt-in: only mount when explicitly enabled, since it
  // holds a hot wallet. Driven by OCTORA_MIXER_RELAYER_ENABLED=true plus the
  // other OCTORA_MIXER_RELAYER_* env vars (see common/config.ts).
  if (config.mixerRelayer) {
    await registerRelayerRoutes(app, config.mixerRelayer, prismaClient ?? null, mixerRegistry)
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
      connection: new Connection(config.executorRpcUrl, 'confirmed'),
      reconciliationRepo: repos.reconciliationRepo,
      log: (msg, ctx) => app.log.info(ctx ?? {}, msg),
    })
    worker.start()
    app.addHook('onClose', async () => worker.stop())
  }

  return app
}
