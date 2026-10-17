// Exercises one rate limit against a server started with a low test value (the LIMIT_* variables
// are read only outside production), for example:
//
//   LIMIT_PER_IP_PER_HOUR=2 vercel dev
//   node --env-file=.env scripts/check-limits.mjs http://localhost:3000 ip 2
//
// kinds: ip (LIMIT_PER_IP_PER_HOUR), sandbox (LIMIT_PER_SANDBOX_TOTAL), site
// (LIMIT_SITE_PER_24_HOURS; pass the value the server was started with). Requests use messages
// the code-only guardrail blocks, so they make no model calls but still count toward the limits.
import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const [base = 'http://localhost:3000', kind = 'ip', limitArg] = process.argv.slice(2);
const limit = Number(limitArg);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
// A documentation-range address per run, so the per-IP count starts at zero.
const ip = `203.0.113.${randomInt(1, 255)}`;

const call = async (path, body, forwardedFor = ip) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-demo-code': process.env.DEMO_PASSCODE, 'x-forwarded-for': forwardedFor },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const sandboxes = [];
const newSandbox = async () => {
  const r = await call('/api/sandbox', {});
  sandboxes.push(r.json.sandboxId);
  return r.json.sandboxId;
};
const blockedMessage = (sandboxId, forwardedFor) =>
  call('/api/chat', { sandboxId, message: 'My number is 123-45-6789' }, forwardedFor);

const statuses = [];
let refusal = null;
const siteCount = async () =>
  (await db.from('usage_log').select('id', { count: 'exact', head: true }).gte('at', new Date(Date.now() - 86400_000).toISOString())).count;

if (kind === 'ip') {
  // Each request from the same IP, spread over fresh sandboxes so only the IP limit applies.
  for (let i = 0; i < limit + 1; i++) {
    const r = await blockedMessage(await newSandbox());
    statuses.push(r.status);
    if (r.status === 429) refusal = r.json.error;
  }
} else if (kind === 'sandbox') {
  // One sandbox, a different IP for each request.
  const sandboxId = await newSandbox();
  for (let i = 0; i < limit + 1; i++) {
    const r = await blockedMessage(sandboxId, `198.51.100.${i + 1}`);
    statuses.push(r.status);
    if (r.status === 429) refusal = r.json.error;
  }
  // A resume upload in the same sandbox is refused too, before the applicant is added.
  const upload = await call('/api/applicants', {
    sandboxId, name: 'Limit Check', role: 'Recruiter',
    resume: { filename: 'r.txt', contentType: 'text/plain', base64: Buffer.from('Recruiter with three years of sourcing.').toString('base64') },
  }, '198.51.100.250');
  const { count } = await db.from('applicants').select('id', { count: 'exact', head: true }).eq('sandbox_id', sandboxId).eq('name', 'Limit Check');
  console.log(`resume upload over the sandbox limit: ${upload.status} "${upload.json?.error}", applicant rows added: ${count}`);
} else if (kind === 'site') {
  const start = await siteCount();
  console.log(`site usage rows in the last 24 hours before the test: ${start}, limit ${limit}`);
  for (let i = 0; start + i <= limit; i++) {
    const r = await blockedMessage(await newSandbox(), `192.0.2.${(i % 250) + 1}`);
    statuses.push(r.status);
    if (r.status === 429) { refusal = r.json.error; break; }
  }
}

console.log(`${kind} limit ${limit}: statuses ${statuses.join(', ')}`);
console.log(`429 message: ${refusal}`);
await db.from('sandboxes').delete().in('id', sandboxes);
const ok = statuses.at(-1) === 429 && statuses.slice(0, -1).every((s) => s === 200);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
