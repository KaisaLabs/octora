import type { FastifyReply, FastifyRequest } from 'fastify'

import { BetaCapExceededError, createPositionService, type PositionServiceDependencies } from './position.service'
import type { PositionRepository } from './position.repository'

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

export interface PositionControllerDeps extends PositionServiceDependencies {
  positionRepo: PositionRepository
}

export function createPositionController(deps: PositionControllerDeps) {
  const service = createPositionService(deps)
  const positionRepo = deps.positionRepo

  const requireWallet = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const wallet = req.wallet?.address
    if (!wallet) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Wallet auth required for this route.',
      })
      return null
    }
    return wallet
  }

  /**
   * Verifies the path-bound position belongs to the authenticated wallet.
   * Returns the wallet on success or null after the reply has been sent.
   */
  const requirePositionOwner = async (
    req: FastifyRequest<{ Params: PositionParams }>,
    reply: FastifyReply,
  ): Promise<string | null> => {
    const wallet = requireWallet(req, reply)
    if (!wallet) return null
    const position = await positionRepo.getPositionById(req.params.positionId)
    if (!position) {
      reply.code(404).send({ message: `Position ${req.params.positionId} not found` })
      return null
    }
    if (position.walletAddress !== wallet) {
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Authenticated wallet does not own this position.',
      })
      return null
    }
    return wallet
  }

  return {
    async createIntent(request: FastifyRequest<{ Body: CreateIntentBody }>, reply: FastifyReply) {
      const wallet = requireWallet(request, reply)
      if (!wallet) return
      try {
        const response = await service.createDraftPositionIntent({
          ...request.body,
          walletAddress: wallet,
        })
        return reply.code(201).send(response)
      } catch (error) {
        if (error instanceof BetaCapExceededError) {
          return reply.code(429).send({ error: 'BetaCapExceeded', message: error.message })
        }
        throw error
      }
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
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
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
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
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
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
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
