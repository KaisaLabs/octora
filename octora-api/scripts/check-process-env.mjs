#!/usr/bin/env node
/**
 * Drift guard: `process.env` reads are only allowed inside
 * `src/common/config/`. Every other module imports `loadConfig`.
 *
 * Phase 0 of docs/backend-refactor-plan.md. Equivalent to the eslint
 * `no-restricted-syntax` rule mentioned there; implemented as a grep
 * script to keep the toolchain dependency-free. Wired into the `lint`
 * script in package.json — run on every CI build.
 *
 * Allowed exceptions:
 *   - `src/common/config/**` (the loader itself)
 *   - `src/test-kit/vitest-env.ts` (writes env, never reads — sets
 *     defaults for the test process before any module loads)
 *
 * Exits 1 on violation with a list of offending file:line refs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const ALLOWED_PREFIXES = ['src/common/config/']
const ALLOWED_FILES = ['src/test-kit/vitest-env.ts']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

const RE = /process\.env\b/
const violations = []

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
  if (ALLOWED_FILES.includes(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (RE.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}`)
  })
}

if (violations.length > 0) {
  console.error('process.env is only allowed in src/common/config/.\n')
  console.error('Route the value through loadConfig() instead.\n')
  console.error('Offenders:')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
