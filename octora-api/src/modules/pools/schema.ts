export const listPoolsSchema = {
  querystring: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
      search: { type: 'string' },
      limit: { type: 'number', default: 50 },
      offset: { type: 'number', default: 0 },
    },
  },
} as const

export const getPoolSchema = {
  params: {
    type: 'object',
    required: ['address'],
    properties: {
      address: { type: 'string', minLength: 32 },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
    },
  },
} as const
