/**
 * Test plan IDs:
 *   MIXER-COMPOUND-001 buildCompoundWithdrawAddLiquidityTransaction throws CompoundCpiNotImplementedError
 *   MIXER-COMPOUND-002 thrown error has stable `code = compound_cpi_not_implemented`
 *   MIXER-COMPOUND-003 error extends ApiError so the global handler maps it to 422
 *
 * Backend boundary guard for issue 05 (rescoped 2026-05-15). The on-chain
 * `compound_withdraw_add_liquidity` ix is fail-closed per ADR-0003; this
 * test pins the backend's matching refusal so accidental wiring trips a
 * typed error instead of silently building an unsignable tx.
 */
import { describe, expect, it } from 'vitest'
import { PublicKey } from '@solana/web3.js'

import { ApiError } from '#common/errors'
import {
  CompoundCpiNotImplementedError,
  buildCompoundWithdrawAddLiquidityTransaction,
} from '../builders/compound-withdraw-add-liquidity.builder.js'
import type { MixerTxContext } from '../builders/types.js'

const FAKE_PUBKEY = new PublicKey('11111111111111111111111111111111')

function buildArgs() {
  return {
    relayerPubkey: FAKE_PUBKEY.toBase58(),
    stealthPubkey: FAKE_PUBKEY.toBase58(),
    withdrawProofBase64: Buffer.alloc(256).toString('base64'),
    withdrawPublicInputsBase64: Buffer.alloc(160).toString('base64'),
    liquidityParamsBase64: Buffer.alloc(0).toString('base64'),
  }
}

// MixerTxContext is intentionally minimal here — the guard MUST throw
// before touching any field on `ctx`. If a future implementation starts
// consuming ctx fields, these tests will fail with a TypeError and the
// author is forced to revisit ADR-0003.
const ctx = {} as unknown as MixerTxContext

describe('buildCompoundWithdrawAddLiquidityTransaction (fail-closed guard)', () => {
  it('MIXER-COMPOUND-001: throws CompoundCpiNotImplementedError when invoked', async () => {
    await expect(
      buildCompoundWithdrawAddLiquidityTransaction(ctx, buildArgs()),
    ).rejects.toBeInstanceOf(CompoundCpiNotImplementedError)
  })

  it('MIXER-COMPOUND-002: error carries stable code `compound_cpi_not_implemented`', async () => {
    let caught: unknown
    try {
      await buildCompoundWithdrawAddLiquidityTransaction(ctx, buildArgs())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CompoundCpiNotImplementedError)
    expect((caught as CompoundCpiNotImplementedError).code).toBe(
      'compound_cpi_not_implemented',
    )
    expect((caught as CompoundCpiNotImplementedError).name).toBe(
      'CompoundCpiNotImplementedError',
    )
  })

  it('MIXER-COMPOUND-003: extends ApiError and maps to HTTP 422', async () => {
    let caught: unknown
    try {
      await buildCompoundWithdrawAddLiquidityTransaction(ctx, buildArgs())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).statusCode).toBe(422)
  })
})
