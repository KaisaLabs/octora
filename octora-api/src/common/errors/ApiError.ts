/**
 * Base class for every error the API throws on purpose.
 *
 * `setErrorHandler` (see ./error-handler.ts) recognizes any `ApiError`
 * and turns it into the standard `{ error: { code, message, details? } }`
 * response body with `statusCode`. Anything that is *not* an `ApiError`
 * falls through to 500 and is logged with a stack trace — that's the
 * signal that something unexpected happened.
 *
 * Subclasses should set `statusCode` and a stable `code` literal. The
 * `code` is what the frontend matches on; the `message` is human-readable
 * and may be shown to users. `details` is optional structured context
 * (validation issues, upstream payload, etc.) and is included in the
 * response unredacted, so don't put secrets in it.
 */
export class ApiError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    if (options?.details !== undefined) this.details = options.details
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}
