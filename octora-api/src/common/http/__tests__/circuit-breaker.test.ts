/**
 * Test plan IDs:
 *   OPS-CB-001 closed→open after `failureThreshold` failures inside window
 *   OPS-CB-002 open fast-fails with `circuit_open` UpstreamError
 *   OPS-CB-003 half-open probe; success closes, failure re-opens
 *   OPS-CB-004 `isExpectedError` does not count toward failures
 *   OPS-CB-005 success inside the window resets the failure counter
 */
import { describe, expect, it } from 'vitest'

import { ApiError } from '../../errors/ApiError.js'
import { CircuitBreaker } from '../circuit-breaker.js'

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('CircuitBreaker', () => {
  it('OPS-CB-001/002: trips after threshold and fast-fails with circuit_open', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 10_000,
      cooldownMs: 5_000,
      now: clock.now,
    })

    const boom = () => Promise.reject(new Error('upstream 500'))
    await expect(breaker.exec(boom)).rejects.toThrow('upstream 500')
    await expect(breaker.exec(boom)).rejects.toThrow('upstream 500')
    expect(breaker.getState()).toBe('closed')
    await expect(breaker.exec(boom)).rejects.toThrow('upstream 500')
    expect(breaker.getState()).toBe('open')

    let caught: unknown
    try {
      await breaker.exec(() => Promise.resolve('should not reach'))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApiError)
    const apiErr = caught as ApiError
    expect(apiErr.code).toBe('circuit_open')
    expect(apiErr.statusCode).toBe(503)
  })

  it('OPS-CB-003: cooldown allows a half-open probe; success closes the breaker', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 10_000,
      cooldownMs: 5_000,
      now: clock.now,
    })

    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(breaker.getState()).toBe('open')

    // Before cooldown elapses, still fast-failing.
    clock.advance(4_999)
    await expect(breaker.exec(() => Promise.resolve('ok'))).rejects.toMatchObject({
      code: 'circuit_open',
    })

    // After cooldown a probe is admitted and a success closes the breaker.
    clock.advance(2)
    await expect(breaker.exec(() => Promise.resolve('recovered'))).resolves.toBe('recovered')
    expect(breaker.getState()).toBe('closed')
  })

  it('OPS-CB-003: half-open probe failure re-opens the breaker', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      windowMs: 10_000,
      cooldownMs: 1_000,
      now: clock.now,
    })

    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(breaker.getState()).toBe('open')

    clock.advance(1_001)
    await expect(breaker.exec(() => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down',
    )
    expect(breaker.getState()).toBe('open')
  })

  it('OPS-CB-004: expected errors do not count toward failure threshold', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 10_000,
      cooldownMs: 1_000,
      isExpectedError: (err) => err instanceof Error && err.message === 'not found',
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      await expect(breaker.exec(() => Promise.reject(new Error('not found')))).rejects.toThrow()
    }
    expect(breaker.getState()).toBe('closed')
  })

  it('OPS-CB-005: success between failures resets the counter', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 10_000,
      cooldownMs: 1_000,
      now: clock.now,
    })

    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    // Success resets the failure window.
    await expect(breaker.exec(() => Promise.resolve('ok'))).resolves.toBe('ok')

    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    await expect(breaker.exec(() => Promise.reject(new Error('x')))).rejects.toThrow()
    // Two new failures shouldn't trip the breaker — it was reset.
    expect(breaker.getState()).toBe('closed')
  })
})
