export const createIntentSchema = {
  body: {
    type: 'object',
    required: ['action', 'amount', 'pool', 'mode'],
    properties: {
      action: { type: 'string', enum: ['add-liquidity', 'claim', 'withdraw-close'] },
      amount: { type: 'string', minLength: 1 },
      pool: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['standard', 'fast-private'] },
    },
  },
} as const

export const executeIntentSchema = {
  body: {
    type: 'object',
    required: ['signedMessage'],
    properties: {
      signedMessage: { type: 'string', minLength: 1 },
    },
  },
} as const

export const positionParamsSchema = {
  params: {
    type: 'object',
    required: ['positionId'],
    properties: {
      positionId: { type: 'string', minLength: 1 },
    },
  },
} as const

export const recordDepositSchema = {
  body: {
    type: 'object',
    required: ['nullifierHash', 'commitment', 'intendedPool', 'denomLamports'],
    properties: {
      nullifierHash: { type: 'string', minLength: 1 },
      commitment: { type: 'string', minLength: 1 },
      intendedPool: { type: 'string', minLength: 1 },
      denomLamports: { type: 'string', minLength: 1 },
      expiresAtIso: { type: 'string', format: 'date-time' },
    },
  },
} as const

export const lpFailedSchema = {
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', minLength: 1 },
    },
  },
} as const

/**
 * close/05 — body for `/claim-fees/remix`. denomLamports is the only
 * required field. The on-chain commitment / leaf-index / signature are
 * optional because the caller may report them in a follow-up call once
 * the on-chain `DepositEvent` lands.
 */
export const remixClaimedFeesSchema = {
  body: {
    type: 'object',
    required: ['denomLamports'],
    properties: {
      denomLamports: { type: 'string', minLength: 1 },
      commitment: { type: 'string', minLength: 1 },
      leafIndex: { type: 'integer', minimum: 0 },
      txSignature: { type: 'string', minLength: 1 },
    },
  },
} as const

/**
 * Body is fully optional — the caller may report just the state
 * transition, with no signature evidence (e.g. broadcast-and-forget on
 * local devnet). `nullable: true` lets fastify accept an absent body
 * without a 400, so the route can still flip the orchestration state
 * even when the browser couldn't capture a signature.
 */
export const recoverFundsSchema = {
  body: {
    type: ['object', 'null'],
    properties: {
      withdrawSignature: { type: 'string', minLength: 1 },
      withdrawRecipient: { type: 'string', minLength: 1 },
    },
  },
} as const

// ── close/02 ──────────────────────────────────────────────────────────
// Body extension for `POST /positions/:positionId/close`. Adds an
// optional `slippageBps` field defaulting to 50 (0.5 %) when absent.
// Out-of-range values are rejected at the schema layer so the
// controller never sees them — Fastify maps validation failures to 422
// through `registerErrorHandler` in `common/errors`.
// `expectedSwapOutLamports` (decimal-string lamports) lets the client
// echo back the expected swap output captured from `GET /close-quote`;
// the adapter uses it to compute `min_amount_out` on the swap ix.
export const closePositionBodySchema = {
  body: {
    // null/absent body is accepted so existing callers (and the
    // close/01 route-test that posts no body) keep working.
    type: ['object', 'null'],
    properties: {
      slippageBps: { type: 'integer', minimum: 10, maximum: 500 },
      expectedSwapOutLamports: { type: 'string', minLength: 1, pattern: '^[0-9]+$' },
    },
  },
} as const
