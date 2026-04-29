import type { FastifyReply, FastifyRequest } from 'fastify'

import { createPositionService, type PositionServiceDependencies } from './position.service'

interface CreateIntentBody {
  action: 'add-liquidity' | 'claim' | 'withdraw-close'
  amount: string
  pool: string
  mode: 'standard' | 'fast-private'
}

interface ExecuteIntentBody {
  signedMessage: string
}

interface PositionParams {
  positionId: string
}

export function createPositionController(deps: PositionServiceDependencies) {
  const service = createPositionService(deps)

  return {
    async createIntent(request: FastifyRequest<{ Body: CreateIntentBody }>, reply: FastifyReply) {
      const response = await service.createDraftPositionIntent(request.body)
      return reply.code(201).send(response)
    },

    async getPosition(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      try {
        const response = await service.getPosition(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        throw error
      }
    },

    async executeIntent(request: FastifyRequest<{ Params: PositionParams; Body: ExecuteIntentBody }>, reply: FastifyReply) {
      try {
        const response = await service.executeSignedIntent({
          positionId: request.params.positionId,
          signedMessage: request.body.signedMessage,
        })
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        throw error
      }
    },

    async claimPosition(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      try {
        const response = await service.claimPosition({ positionId: request.params.positionId })
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        throw error
      }
    },

    async withdrawClosePosition(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      try {
        const response = await service.withdrawClosePosition({ positionId: request.params.positionId })
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        throw error
      }
    },
  }
}

function isPositionNotFoundError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'PositionNotFoundError'
}
