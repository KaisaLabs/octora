import { ApiError } from './ApiError.js'

/**
 * 404. Caller asked for something that does not exist (or that they
 * are not allowed to see — keep the message neutral to avoid leaking
 * existence). Use a more specific code (e.g. `position_not_found`)
 * when the frontend needs to react differently per resource.
 */
export class NotFoundError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(404, options?.code ?? 'not_found', message, options)
  }
}

/**
 * 409. State of the resource doesn't allow this operation
 * (e.g. position already claimed, nullifier already spent).
 */
export class ConflictError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(409, options?.code ?? 'conflict', message, options)
  }
}

/**
 * 422. Request body / params parsed but failed business validation
 * (zod schema rejection, BigInt out of range, base58 not a Pubkey).
 * `details` carries the structured issue list when present.
 */
export class ValidationError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(422, options?.code ?? 'validation_error', message, options)
  }
}

/**
 * 401. No usable credential on the request — missing nonce signature,
 * expired session, etc. Distinct from `ForbiddenError` (403) which
 * means the credential is valid but not authorized for this resource.
 */
export class UnauthorizedError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(401, options?.code ?? 'unauthorized', message, options)
  }
}

/**
 * 403. Caller is authenticated but not allowed (wallet does not own
 * this position, beta cohort gate failed, admin token mismatch).
 */
export class ForbiddenError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(403, options?.code ?? 'forbidden', message, options)
  }
}

/**
 * 429. Rate limit / beta cap / per-wallet cap. The handler echoes
 * `details.retryAfterSeconds` (when present) as a `Retry-After` header.
 */
export class RateLimitedError extends ApiError {
  constructor(message: string, options?: { code?: string; details?: unknown; cause?: unknown }) {
    super(429, options?.code ?? 'rate_limited', message, options)
  }
}

/**
 * 502/503/504 family. An upstream we depend on (Meteora, Jupiter,
 * Solana RPC) is failing in a way that isn't the caller's fault.
 * Default 502; pass an explicit `statusCode` for 503 (we're paused)
 * or 504 (timeout).
 */
export class UpstreamError extends ApiError {
  constructor(
    message: string,
    options?: { statusCode?: 502 | 503 | 504; code?: string; details?: unknown; cause?: unknown },
  ) {
    super(options?.statusCode ?? 502, options?.code ?? 'upstream_error', message, options)
  }
}
