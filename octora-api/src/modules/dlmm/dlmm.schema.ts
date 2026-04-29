const networkQuery = {
  type: 'object',
  properties: {
    network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
  },
} as const

const paginationQuery = {
  type: 'object',
  properties: {
    network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
  },
} as const

export const listPoolsSchema = {
  querystring: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
      search: { type: 'string' },
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
      sortBy: { type: 'string' },
      filterBy: { type: 'string' },
    },
  },
} as const

export const getPoolSchema = {
  params: {
    type: 'object',
    required: ['address'] as const,
    properties: {
      address: { type: 'string', minLength: 32 },
    },
  },
  querystring: networkQuery,
} as const

export const listGroupsSchema = {
  querystring: paginationQuery,
} as const

export const getGroupSchema = {
  params: {
    type: 'object',
    required: ['mintPair'] as const,
    properties: {
      mintPair: { type: 'string', minLength: 1 },
    },
  },
  querystring: paginationQuery,
} as const

export const getOhlcvSchema = {
  params: {
    type: 'object',
    required: ['address'] as const,
    properties: {
      address: { type: 'string', minLength: 32 },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
      startTime: { type: 'integer' },
      endTime: { type: 'integer' },
      resolution: { type: 'string' },
    },
  },
} as const

export const getVolumeHistorySchema = {
  params: {
    type: 'object',
    required: ['address'] as const,
    properties: {
      address: { type: 'string', minLength: 32 },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
      startTime: { type: 'integer' },
      endTime: { type: 'integer' },
      resolution: { type: 'string' },
    },
  },
} as const

export const getProtocolMetricsSchema = {
  querystring: networkQuery,
} as const
