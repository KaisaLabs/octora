import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ApiError, isApiError } from './ApiError.js'

/**
 * Legacy error response body. Matches the shape every existing client
 * (frontend, tests) already expects:
 *
 *   { statusCode, error, message }
 *
 * Phase 0 keeps this as the default. The new envelope
 * (`{ error: { code, message, details? } }`) is opt-in per-route via
 * `common/http/envelope.ts`. Routes flip one at a time after the FE
 * is updated to parse both shapes.
 *
 * `ApiError`s still benefit from the central handler today: the
 * subclass's `statusCode` drives the HTTP code, the class `name` is
 * surfaced as `error`, and `code` is included when present so the FE
 * can already start matching on stable codes without depending on
 * `message`.
 */
export interface LegacyErrorBody {
  statusCode: number
  error: string
  message: string
  /** Stable machine code on `ApiError` subclasses. Absent on unknown errors. */
  code?: string
  /** Structured details for `ApiError` subclasses (validation issues, etc.). */
  details?: unknown
}

/**
 * Install the global error handler.
 *
 * Behavior — kept compatible with the pre-refactor handler:
 *  - `ApiError` → `statusCode` from the subclass, `error: err.name`,
 *    `message: err.message`. `code` and `details` echoed when present.
 *    Echoes `Retry-After` when `details.retryAfterSeconds` is set
 *    (RateLimitedError convention).
 *  - Fastify validation errors → status from Fastify (400 by default),
 *    body unchanged from Fastify's default — keeps every existing
 *    schema-rejection test passing.
 *  - Anything else → 500 with the original message echoed AND the full
 *    stack logged. (Matches the legacy handler — the new envelope mode
 *    is the place to redact internals.)
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (isApiError(err)) {
      sendApiError(reply, err)
      return
    }

    // Fastify validation errors: keep the default 400 + default shape.
    // The new global validator (zod, Phase 0) translates these to
    // `ValidationError` (ApiError) so they still get the new path.
    if (err.validation) {
      reply.status(err.statusCode ?? 400).send({
        statusCode: err.statusCode ?? 400,
        error: err.name ?? 'Bad Request',
        message: err.message,
      })
      return
    }

    // Fastify-tagged 4xx (missing headers, body too large, etc.) — pass
    // through with the legacy shape so existing tests keep matching.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      reply.status(err.statusCode).send({
        statusCode: err.statusCode,
        error: err.name ?? 'Error',
        message: err.message,
      })
      return
    }

    // Unknown 5xx. Log full stack; echo message (legacy behavior — the
    // new envelope mode will redact this).
    req.log.error(
      { err, route: `${req.method} ${req.url}`, stack: err.stack },
      'unhandled error in request',
    )
    reply.status(500).send({
      statusCode: 500,
      error: err.name ?? 'Error',
      message: err.message,
    } satisfies LegacyErrorBody)
  })
}

function sendApiError(reply: FastifyReply, err: ApiError): void {
  if (
    err.statusCode === 429 &&
    err.details &&
    typeof err.details === 'object' &&
    'retryAfterSeconds' in err.details &&
    typeof (err.details as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
  ) {
    reply.header('Retry-After', String((err.details as { retryAfterSeconds: number }).retryAfterSeconds))
  }
  reply.status(err.statusCode).send({
    statusCode: err.statusCode,
    error: err.name,
    message: err.message,
    code: err.code,
    ...(err.details !== undefined ? { details: err.details } : {}),
  } satisfies LegacyErrorBody)
}
