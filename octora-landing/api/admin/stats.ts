import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSql, MissingEnvError } from "../_lib/clients";
import { requireAdmin } from "../_lib/admin-auth";

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

  const [{ total }] = await sql<{ total: string }[]>`SELECT COUNT(*)::text AS total FROM "Waitlist"`;

  const [{ today }] = await sql<{ today: string }[]>`
    SELECT COUNT(*)::text AS today
    FROM "Waitlist"
    WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
  `;

  const [{ week }] = await sql<{ week: string }[]>`
    SELECT COUNT(*)::text AS week
    FROM "Waitlist"
    WHERE "createdAt" >= NOW() - INTERVAL '7 days'
  `;

  const daily = await sql<{ day: string; count: string }[]>`
    SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
           COUNT(*)::text AS count
    FROM "Waitlist"
    WHERE "createdAt" >= NOW() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const sources = await sql<{ source: string | null; count: string }[]>`
    SELECT source, COUNT(*)::text AS count
    FROM "Waitlist"
    GROUP BY source
    ORDER BY COUNT(*) DESC
  `;

  return res.status(200).json({
    total: Number(total),
    today: Number(today),
    week: Number(week),
    daily: daily.map((d) => ({ day: d.day, count: Number(d.count) })),
    sources: sources.map((s) => ({ source: s.source ?? "unknown", count: Number(s.count) })),
  });
}
