import { createHash } from 'node:crypto';
import { check, db } from './supabase.js';
import { HttpError } from './http.js';

// Checked before any model call, from usage_log. Every chat, approval and screening request is
// logged.
export const LIMITS = {
  perIpPerHour: 40,
  perSandboxTotal: 150,
  sitePer24Hours: 1500,
};

// Test hooks such as the limit overrides below are honored only outside production. Vercel sets
// VERCEL_ENV to production in production deployments; vercel dev sets development.
export const isProduction = () => process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

// LIMIT_PER_IP_PER_HOUR, LIMIT_PER_SANDBOX_TOTAL and LIMIT_SITE_PER_24_HOURS lower a limit for a
// test (for example in vercel dev). Ignored in production.
function limit(name: string, fallback: number): number {
  if (isProduction()) return fallback;
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const currentLimits = () => ({
  perIpPerHour: limit('LIMIT_PER_IP_PER_HOUR', LIMITS.perIpPerHour),
  perSandboxTotal: limit('LIMIT_PER_SANDBOX_TOTAL', LIMITS.perSandboxTotal),
  sitePer24Hours: limit('LIMIT_SITE_PER_24_HOURS', LIMITS.sitePer24Hours),
});

// SHA-256 of the client IP plus a secret salt. The raw IP is never stored.
export function ipHash(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  const salt = process.env.IP_HASH_SALT;
  if (!salt) throw new Error('IP_HASH_SALT is not set');
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

const count = async (what: string, build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
  const result = await build();
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.count ?? 0;
};

export async function checkLimits(sandboxId: string, ip: string): Promise<void> {
  const limits = currentLimits();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const usage = () => db().from('usage_log').select('id', { count: 'exact', head: true });
  const [perIp, perSandbox, site] = await Promise.all([
    count('count usage by IP', () => usage().eq('ip_hash', ip).gte('at', hourAgo)),
    count('count usage by sandbox', () => usage().eq('sandbox_id', sandboxId)),
    count('count site usage', () => usage().gte('at', dayAgo)),
  ]);
  if (perIp >= limits.perIpPerHour) {
    throw new HttpError(429, 'You have sent a lot of messages in the last hour. Please wait a while and try again.');
  }
  if (perSandbox >= limits.perSandboxTotal) {
    throw new HttpError(429, 'This sandbox has reached its message limit. Use Start over to get a fresh one.');
  }
  if (site >= limits.sitePer24Hours) {
    throw new HttpError(429, 'The demo has reached its daily limit. Please come back tomorrow.');
  }
}

// Logged before the model is called, so a request that fails halfway still counts toward the
// limits; the counts are filled in afterwards.
export async function startUsage(sandboxId: string, ip: string, kind: 'message' | 'approval' | 'screening'): Promise<number> {
  const row = check(
    await db().from('usage_log').insert({ sandbox_id: sandboxId, ip_hash: ip, kind }).select('id').single(),
    'log usage',
  ) as { id: number };
  return row.id;
}

export async function finishUsage(
  id: number,
  usage: { requests: number; inputTokens: number; outputTokens: number },
): Promise<void> {
  const result = await db()
    .from('usage_log')
    .update({ model_requests: usage.requests, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens })
    .eq('id', id);
  if (result.error) console.error(`[api] update usage ${id} failed: ${result.error.message}`);
}
