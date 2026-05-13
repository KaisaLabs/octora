import { NotFoundError, ValidationError } from './domain-errors.js'

export { ApiError, isApiError } from './ApiError.js'
export {
  NotFoundError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitedError,
  UpstreamError,
} from './domain-errors.js'
export { registerErrorHandler } from './error-handler.js'

// Legacy named exports — services still throw these. Now subclasses of
// ApiError so the global handler maps them automatically. Keep the
// class names so existing `instanceof PositionNotFoundError` checks
// (and stack traces) read the same.
export class PositionNotFoundError extends NotFoundError {
  constructor(positionId: string) {
    super(`Position ${positionId} not found`, { code: 'position_not_found' })
    this.name = 'PositionNotFoundError'
  }
}

export class UnsupportedPositionActionError extends ValidationError {
  constructor(action: string) {
    super(`Task 7 only implements add-liquidity execution, not ${action}`, {
      code: 'unsupported_position_action',
    })
    this.name = 'UnsupportedPositionActionError'
  }
}
