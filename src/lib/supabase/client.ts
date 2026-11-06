import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase is optional. Without NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
 * the app runs fully local (IndexedDB) and changes wait in the outbox.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null | undefined;

export const isSupabaseConfigured = () => Boolean(url && anonKey);

export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  client = url && anonKey ? createClient(url, anonKey, { auth: { persistSession: true } }) : null;
  return client;
}
