import type { VercelRequest, VercelResponse } from "@vercel/node";
import postgres from "postgres";
import { requireAdmin } from "../_lib/admin-auth";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const rows = await sql<{ id: string; email: string; source: string | null; createdAt: Date }[]>`
    SELECT id, email, source, "createdAt"
    FROM "Waitlist"
    ORDER BY "createdAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return res.status(200).json({
    entries: rows.map((r) => ({
      id: r.id,
      email: r.email,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
