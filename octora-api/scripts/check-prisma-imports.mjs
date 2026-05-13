#!/usr/bin/env node
/**
 * Drift guard: `@prisma/client` imports are only allowed inside
 * `src/common/db/` (the client + shared DB helpers) and inside
 * `*.repository.ts` files (the Prisma-bound implementations of the
 * repository interfaces).
 *
 * Phase 1 of docs/backend-refactor-plan.md. Equivalent to an eslint
 * `no-restricted-imports` rule; implemented as a grep script to keep
 * the toolchain dependency-free. Wired into the `lint` script in
 * package.json — run on every CI build.
 *
 * Allowed locations:
 *   - `src/common/db/**`               (PrismaClient construction + ping)
 *   - any file ending in `.repository.ts` (the *only* layer that maps
 *     Prisma rows ↔ domain types).
 *
 * Exits 1 on violation with a list of offending file:line refs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const ALLOWED_PREFIXES = ['src/common/db/']
const ALLOWED_SUFFIX = '.repository.ts'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

// Matches both `import ... from '@prisma/client'` and
// `import type ... from "@prisma/client"`.
const RE = /from\s+['"]@prisma\/client['"]/
const violations = []

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
  if (rel.endsWith(ALLOWED_SUFFIX)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (RE.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}`)
  })
}

if (violations.length > 0) {
  console.error("@prisma/client imports are only allowed in src/common/db/ or *.repository.ts.\n")
  console.error('Move the Prisma call behind a repository interface instead.\n')
  console.error('Offenders:')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
