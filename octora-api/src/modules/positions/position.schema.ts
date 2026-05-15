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
