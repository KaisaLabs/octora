import type { FastifyReply, FastifyRequest } from 'fastify'

import {
  BetaCapExceededError,
  CloseStateTransitionError,
  DepositLpStateTransitionError,
  FeeClaimBelowThresholdError,
  InvalidRecoveryStateError,
  MidPositionFeeClaimStateError,
  createPositionService,
  type PositionServiceDependencies,
} from './position.service'
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

interface RecordDepositBody {
  nullifierHash: string
  commitment: string
  intendedPool: string
  denomLamports: string
  expiresAtIso?: string
}

interface LpFailedBody {
  reason?: string
}

interface RecoverFundsBody {
  /**
   * Signature of the user-signed `mixer.withdraw` tx the browser
   * already submitted. Optional; logged into the activity row when
   * present so the audit trail links to the on-chain artifact.
   */
  withdrawSignature?: string
  /** Address the funds went to (a fresh stealth or the origin wallet). */
  withdrawRecipient?: string
}

// close/02 — body shape for the close-endpoint extension.
interface ClosePositionBody {
  slippageBps?: number
  expectedSwapOutLamports?: string
}

interface RemixClaimedFeesBody {
  /** Mixer Pool denomination (lamports decimal-string). */
  denomLamports: string
  /** Optional client-supplied commitment for the fresh deposit. */
  commitment?: string
  /** Leaf index returned by the on-chain DepositEvent. */
  leafIndex?: number
  /** On-chain signature of the resulting mixer.deposit. */
  txSignature?: string
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

    /**
     * close/01 — drive an `active` Position through the three-tx
     * Private Position Close mainline. 409 when the Position is not
     * in `active` (typed `CloseStateTransitionError`); the orchestrator
     * stamps the matching `*_FAILED` terminal on any leg failure and
     * returns the response with Recovery Guidance baked in.
     *
     * close/02 — accepts optional `{ slippageBps, expectedSwapOutLamports }`
     * body that the orchestrator threads into the swap leg. Schema
     * (`closePositionBodySchema`) enforces the [10, 500] bps range, so
     * the controller never sees out-of-range values; the default lives
     * in `DEFAULT_CLOSE_SLIPPAGE_BPS`.
     */
    async closePosition(
      request: FastifyRequest<{ Params: PositionParams; Body: ClosePositionBody | null }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      const body = request.body ?? {}
      const opts: { slippageBps?: number; expectedSwapOutLamports?: bigint | null } = {}
      if (typeof body.slippageBps === 'number') opts.slippageBps = body.slippageBps
      if (typeof body.expectedSwapOutLamports === 'string') {
        try {
          opts.expectedSwapOutLamports = BigInt(body.expectedSwapOutLamports)
        } catch {
          return reply.code(422).send({
            error: 'ValidationError',
            message: 'expectedSwapOutLamports must be a base-10 lamports integer string.',
          })
        }
      }
      try {
        const response = await service.closePosition(request.params.positionId, opts)
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        if (error instanceof CloseStateTransitionError) {
          return reply.code(409).send({ error: 'StateTransitionRejected', message: error.message })
        }
        throw error
      }
    },

    // ── close/02 ────────────────────────────────────────────────────
    /**
     * close/02 — `GET /positions/:positionId/close-quote`. Returns the
     * structured preview shape: estimated post-close balances, the
     * conditional swap preview (omitted when there's no non-SOL
     * residual above dust), denomination, and sub-denom dust amount.
     * Reshapes `UnsupportedMintExtensionError` (close/04) into the
     * documented `closeable: false, reason: "unsupported_mint"` body
     * so the frontend's `useCanClosePosition` hook can render the
     * disabled-Close v2 badge without an extra round-trip.
     */
    async closeQuote(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      // Read-only: no wallet auth required — the close-quote endpoint
      // is the symmetric pair of `GET /positions/:id`, which is also
      // public. The actual close (mutating) endpoint stays
      // wallet-gated.
      try {
        const response = await service.closeQuote(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        throw error
      }
    },

    /**
     * close/05 — mid-position fee claim. Builds + relayer-signs the
     * fee-claim ix, lands fees in the Stealth Wallet, emits an
     * Activity Record. Position state stays `active`. Throws
     * `MidPositionFeeClaimStateError` (409) when the Position is not
     * in `active`.
     */
    async claimMidPositionFees(
      request: FastifyRequest<{ Params: PositionParams }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.claimMidPositionFees({
          positionId: request.params.positionId,
        })
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        if (error instanceof MidPositionFeeClaimStateError) {
          return reply.code(409).send({
            error: 'StateTransitionRejected',
            code: 'fee_claim_invalid_state',
            message: error.message,
          })
        }
        throw error
      }
    },

    /**
     * close/05 — re-mix the claimed SOL. Wraps the existing Flow 1
     * `mixer.deposit` deposit machinery (the caller drives the deposit
     * ix via /mixer/deposit; this endpoint records the outcome and
     * tags the Activity Record with `source: "fee-claim"`).
     */
    async remixClaimedFees(
      request: FastifyRequest<{ Params: PositionParams; Body: RemixClaimedFeesBody }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.remixClaimedFees({
          positionId: request.params.positionId,
          denomLamports: request.body.denomLamports,
          commitment: request.body.commitment,
          leafIndex: request.body.leafIndex,
          txSignature: request.body.txSignature,
        })
        return reply.send(response)
      } catch (error) {
        if (isPositionNotFoundError(error)) {
          return reply.code(404).send({ message: error.message })
        }
        if (error instanceof MidPositionFeeClaimStateError) {
          return reply.code(409).send({
            error: 'StateTransitionRejected',
            code: 'fee_claim_invalid_state',
            message: error.message,
          })
        }
        if (error instanceof FeeClaimBelowThresholdError) {
          return reply.code(422).send({
            error: 'ValidationError',
            code: 'fee_claim_remix_below_denom',
            message: error.message,
          })
        }
        throw error
      }
    },

    // ── Deposit LP Fallback handlers ────────────────────────────────
    // Each handler drives a single Deposit LP Fallback sub-state
    // transition. `DepositLpStateTransitionError` is mapped to 409 so the
    // caller sees a typed "wrong-state" failure instead of a 500.
    async recordDeposit(
      request: FastifyRequest<{ Params: PositionParams; Body: RecordDepositBody }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.recordDeposit({
          positionId: request.params.positionId,
          ...request.body,
        })
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    async markLpPending(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.markLpPending(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    async markLpDone(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.markLpDone(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    async markLpFailed(
      request: FastifyRequest<{ Params: PositionParams; Body: LpFailedBody }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.markLpFailed(
          request.params.positionId,
          request.body?.reason ?? 'Add liquidity did not settle.',
        )
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    async retryLp(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.retryLp(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    async parkLp(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.parkLp(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    /**
     * Flip the Position to `WITHDRAWN`. The user-signed Recover Funds
     * transaction itself is wired by dust/04 — this endpoint exists so
     * dust/04 has a stable API surface to call once the recovery tx
     * confirms.
     */
    async markWithdrawn(request: FastifyRequest<{ Params: PositionParams }>, reply: FastifyReply) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.markWithdrawn(request.params.positionId)
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },

    /**
     * dust/04 — the user-signed Recover Funds reporting endpoint.
     *
     * The browser has already built, signed, and broadcast a
     * `mixer.withdraw` directly to RPC (no backend relayer involved).
     * This call asserts the Position is in `LP_FAILED` or `PARKED`,
     * records the user-signed-recovery audit row (signature +
     * destination), and drives the transition to `WITHDRAWN`.
     *
     * Best-effort from the client's POV: if the backend is down at this
     * moment, the funds are already safe; the Position stays in
     * `LP_FAILED` / `PARKED` until the next successful call.
     */
    async recoverFundsUserSigned(
      request: FastifyRequest<{ Params: PositionParams; Body: RecoverFundsBody }>,
      reply: FastifyReply,
    ) {
      const wallet = await requirePositionOwner(request, reply)
      if (!wallet) return
      try {
        const response = await service.recoverFundsUserSigned({
          positionId: request.params.positionId,
          withdrawSignature: request.body?.withdrawSignature,
          withdrawRecipient: request.body?.withdrawRecipient,
        })
        return reply.send(response)
      } catch (error) {
        return handleDepositLpError(error, reply)
      }
    },
  }
}

function handleDepositLpError(error: unknown, reply: FastifyReply) {
  if (isPositionNotFoundError(error)) {
    return reply.code(404).send({ message: error.message })
  }
  if (error instanceof DepositLpStateTransitionError) {
    return reply.code(409).send({ error: 'StateTransitionRejected', message: error.message })
  }
  if (error instanceof InvalidRecoveryStateError) {
    return reply.code(409).send({ error: 'InvalidRecoveryState', message: error.message })
  }
  throw error
}

function isPositionNotFoundError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'PositionNotFoundError'
}
