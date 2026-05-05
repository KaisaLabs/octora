import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase, MissingEnvError } from "./clients.js";

export type AdminUser = { id: string; email: string };

export async function requireAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AdminUser | null> {
  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      res.status(500).json({ error: err.message });
      return null;
    }
    throw err;
  }

  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

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
