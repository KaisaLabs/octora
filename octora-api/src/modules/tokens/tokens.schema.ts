export const getTokenIconsSchema = {
  description: 'Token icon URLs from Jupiter, cached 1h. Unknown mints return icon=null.',
  querystring: {
    type: 'object',
    required: ['ids'] as const,
    properties: {
      ids: {
        type: 'string',
        description: 'Comma-separated Solana mint addresses (max 50 per request).',
      },
    },
  },
} as const
