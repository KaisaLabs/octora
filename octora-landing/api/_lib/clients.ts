import postgres from "postgres";
import { Resend } from "resend";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _sql: ReturnType<typeof postgres> | null = null;
let _resend: Resend | null = null;
let _supabase: SupabaseClient | null = null;

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`Missing env var: ${name}`);
    this.name = "MissingEnvError";
  }
}

export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new MissingEnvError("DATABASE_URL");
  _sql = postgres(url, { ssl: "require" });
  return _sql;
}

export function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new MissingEnvError("RESEND_API_KEY");
  _resend = new Resend(key);
  return _resend;
}

export function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url) throw new MissingEnvError("SUPABASE_URL");
  if (!key) throw new MissingEnvError("SUPABASE_ANON_KEY");
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

export const FROM_ADDRESS =
  process.env.EMAIL_FROM ?? "Octora <onboarding@resend.dev>";
