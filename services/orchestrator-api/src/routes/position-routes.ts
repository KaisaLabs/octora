import type { FastifyInstance, FastifyRequest } from "fastify";

import type { OrchestratorDb } from "../modules/db";
import { createOrchestratorService, type CreateDraftPositionIntentInput, PositionNotFoundError } from "../modules/orchestrator/orchestrator-service";

interface PositionRoutesOptions {
  db: OrchestratorDb;
}

interface CreateIntentBody {
  action: string;
  amount: string;
  pool: string;
  mode: string;
}

interface PositionParams {
  positionId: string;
}

export async function registerPositionRoutes(app: FastifyInstance, options: PositionRoutesOptions) {
  const service = createOrchestratorService(options.db);

  app.post("/positions/intents", async (request, reply) => {
    const body = parseCreateIntentBody(request);
    if (!body.ok) {
      return reply.code(400).send({ message: body.message });
    }

    const response = await service.createDraftPositionIntent(body.body);
    return reply.code(201).send(response);
  });

  app.get("/positions/:positionId", async (request, reply) => {
    const { positionId } = request.params as PositionParams;

    try {
      const response = await service.getPosition(positionId);
      return reply.send(response);
    } catch (error) {
      if (isPositionNotFoundError(error)) {
        return reply.code(404).send({ message: error.message });
      }

      throw error;
    }
  });
}

function parseCreateIntentBody(request: FastifyRequest): { ok: true; message?: never; body: CreateDraftPositionIntentInput } | { ok: false; message: string } {
  const body = request.body as Partial<CreateIntentBody> | undefined;
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body is required" };
  }

  const { action, amount, pool, mode } = body;
  if (action !== "add-liquidity" && action !== "claim" && action !== "withdraw-close") {
    return { ok: false, message: "Invalid action" };
  }

  if (typeof amount !== "string" || amount.length === 0) {
    return { ok: false, message: "Amount is required" };
  }

  if (typeof pool !== "string" || pool.length === 0) {
    return { ok: false, message: "Pool is required" };
  }

  if (mode !== "standard" && mode !== "fast-private") {
    return { ok: false, message: "Invalid mode" };
  }

  return { ok: true, body: { action, amount, pool, mode } };
}

function isPositionNotFoundError(error: unknown): error is PositionNotFoundError {
  return error instanceof PositionNotFoundError;
}
