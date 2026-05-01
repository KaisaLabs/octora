import type { FastifyInstance } from "fastify";
import type { WaitlistRepository } from "./waitlist.repository";
import { sendWaitlistConfirmation } from "./email.service";

export interface WaitlistRouteDeps {
  waitlistRepo: WaitlistRepository;
}

export async function registerWaitlistRoutes(app: FastifyInstance, { waitlistRepo }: WaitlistRouteDeps) {
  const tags = ["Waitlist"];

  app.post(
    "/waitlist",
    {
      schema: {
        tags,
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            source: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          409: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, source } = request.body as { email: string; source?: string };

      const already = await waitlistRepo.exists(email);
      if (already) {
        return reply.status(409).send({ error: "Email already on waitlist" });
      }

      const entry = await waitlistRepo.add(email, source);

      sendWaitlistConfirmation(email).catch((err) => {
        request.log.error({ err, email }, "Failed to send waitlist confirmation email");
      });

      return reply.status(201).send(entry);
    }
  );
}
