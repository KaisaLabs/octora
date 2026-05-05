import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const allowed = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export type AdminUser = { id: string; email: string };

export async function requireAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AdminUser | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: "Supabase env not configured" });
    return null;
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user || !data.user.email) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }

  const email = data.user.email.toLowerCase();
  if (allowed.length === 0) {
    res.status(500).json({ error: "ADMIN_EMAILS not configured" });
    return null;
  }
  if (!allowed.includes(email)) {
    res.status(403).json({ error: "Not on admin allowlist" });
    return null;
  }

  return { id: data.user.id, email };
}
