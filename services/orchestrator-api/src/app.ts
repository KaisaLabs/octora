import Fastify from "fastify";

import { createPrismaDb, type OrchestratorDb } from "./modules/db";
import { registerPositionRoutes } from "./routes/position-routes";

export interface CreateAppOptions {
  db?: OrchestratorDb;
  logger?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  const db = options.db ?? createPrismaDb();

  app.get("/health", async () => ({ ok: true }));
  registerPositionRoutes(app, { db });

  return app;
}
