/**
 * Generic circuit breaker for outbound HTTP. Wraps a single upstream
 * (e.g. Meteora, Jupiter) so a sustained burst of failures stops us
 * hammering an already-degraded dependency.
 *
 * State machine:
 *   - closed:    requests flow through; failures inside the rolling
 *                window are counted. `failureThreshold` consecutive
 *                failures within `windowMs` trips the breaker.
 *   - open:      requests fast-fail with `UpstreamError(503, 'circuit_open')`
 *                without touching the network. After `cooldownMs` the
 *                breaker transitions to half-open.
 *   - half-open: a single probe request is allowed; success closes the
 *                breaker, failure re-opens it (and resets the cooldown).
 *                Concurrent calls while half-open fast-fail to keep the
 *                probe single-flight.
 *
 * Errors deemed "expected" (e.g. 404 from a missing-pool lookup) bypass
 * failure accounting via `isExpectedError`. They still propagate to the
 * caller; they just don't move the breaker towards open.
 */
import { UpstreamError } from '#common/errors'

export interface CircuitBreakerOptions {
  /** Identifier surfaced in errors / logs (e.g. 'meteora', 'jupiter'). */
  name: string
  /** Consecutive failures within `windowMs` that trip the breaker. */
  failureThreshold: number
  /** Sliding-window length used to discard old failures. */
  windowMs: number
  /** How long to stay open before allowing a half-open probe. */
  cooldownMs: number
  /**
   * Predicate that returns true when an error should NOT count toward
   * failure accounting (e.g. an upstream 404). Defaults to all errors
   * counted.
   */
  isExpectedError?: (err: unknown) => boolean
  /** Optional clock injection for tests. */
  now?: () => number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
  private readonly options: Required<Omit<CircuitBreakerOptions, 'isExpectedError'>> & {
    isExpectedError: (err: unknown) => boolean
  }
  private state: CircuitState = 'closed'
  private failureTimestamps: number[] = []
  private openedAt = 0
  private halfOpenInFlight = false

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      name: options.name,
      failureThreshold: options.failureThreshold,
      windowMs: options.windowMs,
      cooldownMs: options.cooldownMs,
      isExpectedError: options.isExpectedError ?? (() => false),
      now: options.now ?? Date.now,
    }
  }

  getState(): CircuitState {
    return this.state
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.options.now()

    if (this.state === 'open') {
      if (now - this.openedAt < this.options.cooldownMs) {
        throw this.openError()
      }
      this.state = 'half-open'
      this.halfOpenInFlight = false
    }

    if (this.state === 'half-open') {
      if (this.halfOpenInFlight) {
        throw this.openError()
      }
      this.halfOpenInFlight = true
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onError(err)
      throw err
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = false
    }
    this.state = 'closed'
    this.failureTimestamps = []
    this.openedAt = 0
  }

  private onError(err: unknown): void {
    if (this.options.isExpectedError(err)) {
      if (this.state === 'half-open') {
        // Expected error during a probe doesn't prove recovery; keep the
        // breaker half-open but free the in-flight slot for a real probe.
        this.halfOpenInFlight = false
      }
      return
    }

    const now = this.options.now()
    if (this.state === 'half-open') {
      this.trip(now)
      return
    }

    this.failureTimestamps.push(now)
    const cutoff = now - this.options.windowMs
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff)

    if (this.failureTimestamps.length >= this.options.failureThreshold) {
      this.trip(now)
    }
  }

  private trip(now: number): void {
    this.state = 'open'
    this.openedAt = now
    this.failureTimestamps = []
    this.halfOpenInFlight = false
  }

  private openError(): UpstreamError {
    return new UpstreamError(`${this.options.name} circuit breaker is open`, {
      statusCode: 503,
      code: 'circuit_open',
      details: { upstream: this.options.name },
    })
  }
}
