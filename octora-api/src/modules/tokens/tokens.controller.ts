import type { FastifyReply, FastifyRequest } from 'fastify'

import { getTokenIcons, JupiterTokensError } from './tokens.service'

interface TokenIconsQuery {
  ids?: string
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export async function getTokenIconsHandler(
  request: FastifyRequest<{ Querystring: TokenIconsQuery }>,
  reply: FastifyReply,
) {
  const idsRaw = request.query.ids ?? ''
  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SOLANA_PUBKEY_RE.test(s))

  if (ids.length === 0) {
    return reply.code(400).send({ message: 'Provide at least one mint via ?ids=mint1,mint2' })
  }

  try {
    const icons = await getTokenIcons(ids)
    return reply.send({ data: icons })
  } catch (err) {
    if (err instanceof JupiterTokensError) {
      return reply.code(502).send({ message: err.message })
    }
    throw err
  }
}
