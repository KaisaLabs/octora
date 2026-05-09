export const getPricesSchema = {
  description: 'USD prices from Jupiter Price API v3, cached 5s.',
  querystring: {
    type: 'object',
    required: ['ids'] as const,
    properties: {
      ids: {
        type: 'string',
        description: 'Comma-separated Solana mint addresses (max 100).',
      },
    },
  },
} as const
