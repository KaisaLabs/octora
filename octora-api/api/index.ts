import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp } from '#app'

type FastifyApp = Awaited<ReturnType<typeof createApp>>

let appPromise: Promise<FastifyApp> | null = null

async function getApp(): Promise<FastifyApp> {
  if (!appPromise) {
    appPromise = createApp({ logger: true }).then(async (app) => {
      await app.ready()
      return app
    })
  }
  return appPromise
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp()
  app.server.emit('request', req, res)
}
