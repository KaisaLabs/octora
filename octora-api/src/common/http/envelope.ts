import type { FastifyReply } from 'fastify'

/**
 * Standard response envelope.
 *
 *   Success: `{ data: T }`
 *   Failure: `{ error: { code, message, details? } }`
 *
 * Phase 0 ships the envelope as an opt-in: routes call `sendData()` /
 * `sendApiError()` (the global handler emits the legacy shape by
 * default — see common/errors/error-handler.ts). Phase 1 flips routes
 * one at a time once the frontend is updated to parse both shapes.
 *
 * Why not flip everything at once: the current frontend (octora-web)
 * matches on top-level `message` and `error` fields for several error
 * surfaces. Changing every route in one PR would break those silently;
 * the per-route flip is reviewable and revertable.
 */
export interface SuccessEnvelope<T> {
  data: T
}

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope

export function sendData<T>(reply: FastifyReply, data: T, statusCode = 200): FastifyReply {
  return reply.status(statusCode).send({ data } satisfies SuccessEnvelope<T>)
}

export function sendCreated<T>(reply: FastifyReply, data: T): FastifyReply {
  return sendData(reply, data, 201)
}

/**
 * Build the error envelope body for an `ApiError`. Use when manually
 * shaping an error response inside a controller; the global handler
 * still emits the legacy shape by default.
 */
export function envelopeError(
  code: string,
  message: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  }
}
