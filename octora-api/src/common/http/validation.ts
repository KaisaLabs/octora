import type { FastifySchema } from 'fastify'
import { z } from 'zod'

import { ValidationError } from '#common/errors'

/**
 * Zod → Fastify schema bridge.
 *
 * Fastify validates requests against JSON Schema, and `@fastify/swagger`
 * generates OpenAPI from those same schemas. We want zod for two reasons:
 *
 *   1. Runtime parsing with strong domain types (BigInt strings,
 *      base58 PublicKeys, denomination enums) — JSON Schema can express
 *      *shape*, not value-level invariants.
 *   2. One source of truth shared between server and the frontend
 *      types package (Phase 1).
 *
 * The bridge converts zod schemas to JSON Schema for Fastify's
 * validator, and Fastify's validation errors flow through the global
 * error handler (`common/errors/error-handler.ts`).
 *
 * For richer parsing (BigInt, base58, etc.) prefer `parseWith` inside
 * the controller — it throws `ValidationError` directly with the zod
 * issue list under `details`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZodLike = z.ZodType<any, any>

export interface ZodFastifySchemas {
  body?: ZodLike
  querystring?: ZodLike
  params?: ZodLike
  headers?: ZodLike
  /** Map of HTTP status code → response schema. */
  response?: Record<number | string, ZodLike>
}

/**
 * Convert a bundle of zod schemas to a Fastify-compatible `schema`
 * option. Inherits any extra options (tags, description, summary)
 * passed via `extra`.
 */
export function zodSchema(
  schemas: ZodFastifySchemas,
  extra?: Omit<FastifySchema, 'body' | 'querystring' | 'params' | 'headers' | 'response'>,
): FastifySchema {
  const out: FastifySchema = { ...extra }
  if (schemas.body) out.body = toJsonSchema(schemas.body)
  if (schemas.querystring) out.querystring = toJsonSchema(schemas.querystring)
  if (schemas.params) out.params = toJsonSchema(schemas.params)
  if (schemas.headers) out.headers = toJsonSchema(schemas.headers)
  if (schemas.response) {
    out.response = Object.fromEntries(
      Object.entries(schemas.response).map(([status, schema]) => [status, toJsonSchema(schema)]),
    )
  }
  return out
}

function toJsonSchema(schema: ZodLike): Record<string, unknown> {
  // `target: "draft-7"` matches what @fastify/swagger + Scalar expect.
  // `io: "input"` emits the schema as parsed *from* the wire (the type
  // before zod coercion/transform) — which is what Fastify needs to
  // validate raw request bodies.
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

/**
 * Parse an arbitrary value against a zod schema, throwing
 * `ValidationError` (422) on failure. Use this inside controllers to
 * coerce path / body fragments into rich domain types (BigInt strings,
 * PublicKeys) when JSON Schema isn't expressive enough.
 */
export function parseWith<T extends ZodLike>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ValidationError('Request failed validation.', {
      details: { issues: result.error.issues },
    })
  }
  return result.data
}
