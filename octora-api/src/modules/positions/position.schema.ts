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
