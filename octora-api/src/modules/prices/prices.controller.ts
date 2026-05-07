import type { FastifyReply, FastifyRequest } from 'fastify'

import { getPrices, JupiterPriceError } from './prices.service'

interface PricesQuery {
  ids?: string
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export async function getPricesHandler(
  request: FastifyRequest<{ Querystring: PricesQuery }>,
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
    const prices = await getPrices(ids)
    return reply.send({ data: prices })
  } catch (err) {
    if (err instanceof JupiterPriceError) {
      return reply.code(502).send({ message: err.message })
    }
    throw err
  }
}
