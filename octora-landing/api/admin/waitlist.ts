import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSql, MissingEnvError } from "../_lib/clients.js";
import { requireAdmin } from "../_lib/admin-auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAdmin(req, res))) return;

  let sql;
  try {
    sql = getSql();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return res.status(500).json({ error: err.message });
    }
    throw err;
  }

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
