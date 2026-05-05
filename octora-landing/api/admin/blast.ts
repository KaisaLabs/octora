import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FROM_ADDRESS, getResend, getSql, MissingEnvError } from "../_lib/clients";
import { requireAdmin } from "../_lib/admin-auth";

type BlastBody = {
  subject?: string;
  html?: string;
  source?: string;
  dryRun?: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAdmin(req, res))) return;

  const { subject, html, source, dryRun }: BlastBody = req.body ?? {};

  if (!subject || subject.trim().length < 3) {
    return res.status(400).json({ error: "Subject is required (min 3 chars)" });
  }
  if (!html || html.trim().length < 10) {
    return res.status(400).json({ error: "HTML body is required (min 10 chars)" });
  }

  let sql, resend;
  try {
    sql = getSql();
    resend = getResend();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return res.status(500).json({ error: err.message });
    }
    throw err;
  }

  const recipients = source
    ? await sql<{ email: string }[]>`SELECT email FROM "Waitlist" WHERE source = ${source}`
    : await sql<{ email: string }[]>`SELECT email FROM "Waitlist"`;

  if (dryRun) {
    return res.status(200).json({ dryRun: true, count: recipients.length });
  }

  let sent = 0;
  const failures: { email: string; error: string }[] = [];

  // Resend batch endpoint accepts up to 100 emails per call.
  const batchSize = 100;
  for (let i = 0; i < recipients.length; i += batchSize) {
    const slice = recipients.slice(i, i + batchSize);
    const payload = slice.map((r) => ({
      from: FROM_ADDRESS,
      to: r.email,
      subject,
      html,
    }));

    try {
      const result = await resend.batch.send(payload);
      if (result.error) {
        slice.forEach((r) => failures.push({ email: r.email, error: result.error!.message }));
      } else {
        sent += slice.length;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      slice.forEach((r) => failures.push({ email: r.email, error: msg }));
    }
  }

  return res.status(200).json({
    total: recipients.length,
    sent,
    failed: failures.length,
    failures: failures.slice(0, 20),
  });
}
