import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'

function vercelApiDevPlugin(): Plugin {
  return {
    name: 'vercel-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/')) return next()

        const [pathname, queryString = ''] = url.split('?')
        const apiRel = pathname.replace(/^\/api\//, '').replace(/\/$/, '')
        const candidates = [
          path.resolve(__dirname, 'api', `${apiRel}.ts`),
          path.resolve(__dirname, 'api', apiRel, 'index.ts'),
        ]
        const handlerPath = candidates.find((p) => fs.existsSync(p))
        if (!handlerPath) return next()

        try {
          const mod = await server.ssrLoadModule(handlerPath)
          const handler = mod.default
          if (typeof handler !== 'function') {
            res.statusCode = 500
            res.end('Handler has no default export')
            return
          }

          const body = await readJsonBody(req)
          const query = Object.fromEntries(new URLSearchParams(queryString))

          const vReq = Object.assign(req, { body, query })
          const vRes = wrapResponse(res)

          await handler(vReq, vRes)
        } catch (err) {
          console.error('[vercel-api-dev]', err)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: (err as Error).message }))
          }
        }
      })
    },
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(undefined)
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw)
      }
    })
    req.on('error', reject)
  })
}

function wrapResponse(res: ServerResponse) {
  const enriched = res as ServerResponse & {
    status: (code: number) => typeof enriched
    json: (data: unknown) => typeof enriched
  }
  enriched.status = (code: number) => {
    res.statusCode = code
    return enriched
  }
  enriched.json = (data: unknown) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
    return enriched
  }
  return enriched
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v
  }

  return {
    plugins: [react(), tailwindcss(), vercelApiDevPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})
