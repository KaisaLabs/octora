import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FROM_ADDRESS, getResend, getSql, MissingEnvError } from "./_lib/clients.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, source } = req.body ?? {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
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

  const existing = await sql`SELECT id FROM "Waitlist" WHERE email = ${email}`;
  if (existing.length > 0) {
    return res.status(409).json({ error: "Email already on waitlist" });
  }

  const [entry] = await sql`
    INSERT INTO "Waitlist" (id, email, source, "createdAt")
    VALUES (gen_random_uuid(), ${email}, ${source ?? null}, NOW())
    RETURNING id, email, "createdAt"
  `;

  // Send confirmation email (must await — Vercel kills the runtime after response)
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: "You're on the Octora waitlist!",
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
  <img src="https://qfqnraeumxtxpiyxlcqh.supabase.co/storage/v1/object/public/assets/BANNER.png" alt="Octora - Private LP on Meteora" style="width: 100%; max-width: 480px; height: auto; display: block; margin: 0 0 24px 0; border-radius: 8px;" />
  <h1 style="font-size: 24px; font-weight: 600; color: #000000; margin: 0 0 16px;">Welcome to Octora</h1>
  <p style="font-size: 15px; line-height: 1.6; color: #000000; margin: 0 0 16px;">Thanks for joining the waitlist! You're now in line for early access to private liquidity provisioning on Meteora.</p>
  <p style="font-size: 15px; line-height: 1.6; color: #000000; margin: 0 0 16px;">We'll notify you as soon as a spot opens up. In the meantime, stay tuned — we're building something special for LPs who value privacy.</p>
  <div style="margin: 32px 0 32px 0;">
    <a href="https://x.com/octora_xyz" target="_blank" style="display: inline-block; background-color: #000000; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 6px;">Follow @octora_xyz on X</a>
  </div>
  <p style="font-size: 14px; color: #000000; margin: 24px 0 0;">— The Octora Team</p>
</div>`,
    });
  } catch (err) {
    console.error("Failed to send email:", err);
  }

  return res.status(201).json(entry);
}
