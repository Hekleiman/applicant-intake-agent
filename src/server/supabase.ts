import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// One client per function instance, created on first use. It carries the secret key, so it is
// only ever imported by server code and never placed in a run context or a response.
let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

// Postgres unique_violation.
export const UNIQUE_VIOLATION = '23505';

// Throws a plain Error for a failed query, so callers can rely on a value or an exception.
export function check<T>(result: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (result.error) {
    const error = new Error(`${what}: ${result.error.message}`) as Error & { code?: string };
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}
