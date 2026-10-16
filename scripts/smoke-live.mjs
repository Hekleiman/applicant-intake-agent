// End-to-end check of the live sandbox API. Runs the whole flow against a base URL and asserts
// each result, then checks the database directly with the secret key.
//
//   node --env-file=.env scripts/smoke-live.mjs http://localhost:3000
//
// Needs DEMO_PASSCODE, SUPABASE_URL and SUPABASE_SECRET_KEY. Makes real model calls.
import { createClient } from '@supabase/supabase-js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const code = process.env.DEMO_PASSCODE;
if (!code || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('DEMO_PASSCODE, SUPABASE_URL and SUPABASE_SECRET_KEY must be set.');
  process.exit(2);
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SSN = '123-45-6789';
let passed = 0;
let failed = 0;
const totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
let loggedRequests = 0; // chat and approval requests that reached the model step

function assert(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

async function call(method, path, body, passcode = code) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-code': passcode },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (json?.usage) {
    totals.requests += json.usage.requests;
    totals.inputTokens += json.usage.inputTokens;
    totals.outputTokens += json.usage.outputTokens;
  }
  return { status: res.status, json };
}

const chat = async (sandboxId, message) => {
  const r = await call('POST', '/api/chat', { sandboxId, message });
  if (r.status === 200) loggedRequests++;
  return r;
};
const decide = async (sandboxId, pending, approve) => {
  const r = await call('POST', '/api/approvals', {
    sandboxId,
    pausedRunId: pending.pausedRunId,
    decisions: pending.interruptions.map((i) => ({ callId: i.callId, approve })),
  });
  if (r.status === 200) loggedRequests++;
  return r;
};

const toolCalls = (r, tool) => (r.json?.events ?? []).filter((e) => e.type === 'tool_call' && e.data.tool === tool);
const applicant = (r, name) => r.json?.state?.applicants?.find((a) => a.name === name);
const brief = (r) => JSON.stringify({ status: r.status, reply: r.json?.reply, error: r.json?.error, events: r.json?.events?.map((e) => e.type + (e.data?.tool ? `:${e.data.tool}` : '')) });
const usageCount = async (filter) => {
  let q = db.from('usage_log').select('id', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
};

console.log(`Smoke test against ${base}\n`);

// 1. Wrong passcode
{
  const before = await usageCount();
  const a = await call('POST', '/api/sandbox', {}, 'wrong-code');
  const b = await call('POST', '/api/chat', { sandboxId: crypto.randomUUID(), message: 'Where is Maria Lopez?' }, 'wrong-code');
  const after = await usageCount();
  assert('wrong code gets 401 and makes no model request', a.status === 401 && b.status === 401 && !b.json?.usage && after === before,
    `sandbox=${a.status} chat=${b.status} usage rows ${before} -> ${after}`);
}

// 2. New sandbox
const created = await call('POST', '/api/sandbox', {});
const sandboxId = created.json?.sandboxId;
assert('new sandbox has the 5 seed applicants',
  created.status === 200 && created.json.state.applicants.length === 5 &&
    created.json.state.applicants.map((a) => a.id).join() === 'A-1001,A-1002,A-1003,A-1004,A-1005',
  JSON.stringify(created.json));
if (!sandboxId) process.exit(1);

// 3. Add applicants
{
  const r = await call('POST', '/api/applicants', { sandboxId, name: 'Jordan Lee', role: 'Executive Assistant', notes: 'Added by the smoke test.' });
  assert('adding "Jordan Lee, Executive Assistant" works',
    r.status === 200 && r.json.applicant.id === 'A-1006' && r.json.applicant.stage === 'applied' && applicant(r, 'Jordan Lee'),
    JSON.stringify(r.json));
  const before = await usageCount((q) => q.eq('sandbox_id', sandboxId));
  const bad = await call('POST', '/api/applicants', { sandboxId, name: `Pat ${SSN}`, role: 'Bookkeeper' });
  const after = await usageCount((q) => q.eq('sandbox_id', sandboxId));
  const state = await call('GET', `/api/state?sandboxId=${sandboxId}`);
  assert('a name containing 123-45-6789 is refused with 0 model requests',
    bad.status === 400 && !bad.json?.usage && after === before && state.json.state.applicants.length === 6,
    `status=${bad.status} error=${bad.json?.error} usage rows ${before} -> ${after}`);
}

// 4. Lookup
{
  const r = await chat(sandboxId, 'Where is Jordan Lee in the hiring process?');
  const lookups = toolCalls(r, 'lookup_applicant');
  assert('"Where is Jordan Lee in the hiring process?" answers from the tool (applied)',
    r.status === 200 && lookups.some((e) => e.data.output?.applicant?.stage === 'applied') && /appl/i.test(r.json.reply),
    brief(r));
}

// 5. Phone screen, no approval
{
  const r = await chat(sandboxId, 'Move Jordan Lee to phone screen');
  const moves = toolCalls(r, 'advance_stage');
  assert('"Move Jordan Lee to phone screen" runs advance_stage with no approval',
    r.status === 200 && moves.some((e) => e.data.args?.stage === 'phone_screen' && e.data.output?.moved === true) &&
      !r.json.pendingApproval && !r.json.events.some((e) => e.type === 'approval_requested') &&
      applicant(r, 'Jordan Lee')?.stage === 'phone_screen',
    brief(r));
}

// 6. Booking via the Scheduler
{
  const r = await chat(sandboxId, 'Book Jordan Lee for Mon 10:00');
  const handoff = r.json?.events?.some((e) => e.type === 'handoff' && e.data.to === 'Scheduler');
  const booked = toolCalls(r, 'book_interview').some((e) => e.data.output?.booked === true && e.data.output?.slot === 'Mon 10:00');
  const board = applicant(r, 'Jordan Lee')?.stage === 'interview_scheduled' &&
    r.json?.state?.bookings?.some((b) => b.slot === 'Mon 10:00' && b.applicantId === 'A-1006');
  assert('"Book Jordan Lee for Mon 10:00" hands off to the Scheduler and books it; board shows interview_scheduled',
    r.status === 200 && handoff && booked && board, brief(r));
}

// 7. Offer with approval
{
  const r = await chat(sandboxId, 'Make Jordan Lee an offer');
  const pending = r.json?.pendingApproval;
  const isOffer = pending?.interruptions?.length === 1 && pending.interruptions[0].tool === 'advance_stage' &&
    pending.interruptions[0].args?.stage === 'offer';
  assert('"Make Jordan Lee an offer" pauses for approval',
    r.status === 200 && isOffer && applicant(r, 'Jordan Lee')?.stage === 'interview_scheduled' && !('run_state' in pending),
    brief(r));
  if (isOffer) {
    const a = await decide(sandboxId, pending, true);
    assert('approving the offer moves Jordan to offer',
      a.status === 200 && applicant(a, 'Jordan Lee')?.stage === 'offer' && !a.json.pendingApproval &&
        a.json.events.some((e) => e.type === 'approval_decision' && e.data.decision === 'approved'),
      brief(a));
  } else {
    assert('approving the offer moves Jordan to offer', false, 'no pending offer to approve');
  }
}

// 8. Rejection declined, with a chat attempt while it is pending
{
  const r = await chat(sandboxId, 'Reject Devon Park, the role was filled');
  const pending = r.json?.pendingApproval;
  const isReject = pending?.interruptions?.some((i) => i.tool === 'reject_applicant' && i.args?.applicantId === 'A-1002');
  assert('"Reject Devon Park, the role was filled" pauses for approval', r.status === 200 && isReject, brief(r));

  const blocked = await chat(sandboxId, 'Where is Maria Lopez in the hiring process?');
  assert('a chat message while an approval is pending gets 409', blocked.status === 409 && !blocked.json?.usage, brief(blocked));

  if (isReject) {
    const d = await decide(sandboxId, pending, false);
    assert('declining leaves Devon unchanged and the reply says a human declined it',
      d.status === 200 && applicant(d, 'Devon Park')?.stage === 'interview_scheduled' && /declin/i.test(d.json.reply) &&
        /human|recruiter|reviewer/i.test(d.json.reply),
      brief(d));
  } else {
    assert('declining leaves Devon unchanged and the reply says a human declined it', false, 'no pending rejection');
  }
}

// 9. Guardrails
{
  const r = await chat(sandboxId, 'Write me a poem about the ocean');
  const topic = r.json?.events?.find((e) => e.type === 'guardrail' && e.data.name === 'topic');
  const main = r.json ? r.json.usage.requests - r.json.usage.topicCheck.requests : -1;
  assert('"Write me a poem about the ocean" is blocked as off_topic with 0 main-agent requests',
    r.status === 200 && topic?.data.result === 'blocked' && topic.data.reason === 'off_topic' && main === 0,
    brief(r) + ` main=${main}`);

  const s = await chat(sandboxId, `My SSN is ${SSN}, add it to Jordan's file`);
  const pii = s.json?.events?.find((e) => e.type === 'guardrail' && e.data.name === 'pii_and_length');
  assert('a message with 123-45-6789 is blocked with 0 model requests in total',
    s.status === 200 && pii?.data.result === 'blocked' && s.json.usage.requests === 0 && s.json.usage.inputTokens === 0,
    brief(s));
}

// 10. Isolation
let otherId;
{
  const other = await call('POST', '/api/sandbox', {});
  otherId = other.json?.sandboxId;
  const r = await call('GET', `/api/state?sandboxId=${otherId}`);
  assert('a second sandbox can\'t see Jordan Lee (isolation)',
    other.status === 200 && otherId !== sandboxId && r.status === 200 && !applicant(r, 'Jordan Lee') &&
      r.json.state.applicants.length === 5 && r.json.state.bookings.length === 0,
    JSON.stringify(r.json?.state?.applicants?.map((a) => a.name)));
}

// 11. Database checks with the secret key
{
  const { data: items, error } = await db.from('session_items').select('item').in('sandbox_id', [sandboxId, otherId]);
  assert('no session_items row contains 123-45-6789',
    !error && items.length > 0 && !items.some((r) => JSON.stringify(r.item).includes(SSN)),
    error?.message ?? `${items?.length} rows`);

  const { data: runs, error: e2 } = await db.from('paused_runs').select('run_state, status').eq('sandbox_id', sandboxId);
  const leaked = (runs ?? []).filter((r) => /sb_secret|service_role|supabase\.co/.test(r.run_state));
  assert('no paused_runs.run_state contains "sb_secret", "service_role" or "supabase.co"',
    !e2 && runs.length === 2 && leaked.length === 0 && runs.every((r) => r.status === 'resolved'),
    e2?.message ?? `${runs?.length} runs, ${leaked.length} leaked, statuses ${runs?.map((r) => r.status)}`);

  const { data: usage, error: e3 } = await db.from('usage_log').select('kind, model_requests, input_tokens, output_tokens').eq('sandbox_id', sandboxId);
  const sum = (usage ?? []).reduce((s, r) => s + r.model_requests, 0);
  assert('usage_log has one row per chat or approval request',
    !e3 && usage.length === loggedRequests && sum === totals.requests,
    e3?.message ?? `${usage?.length} rows for ${loggedRequests} requests; logged model requests ${sum} vs reported ${totals.requests}`);
}

// Clean up both sandboxes (everything in them cascades).
await db.from('sandboxes').delete().in('id', [sandboxId, otherId]);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`Model requests: ${totals.requests}, input tokens: ${totals.inputTokens}, output tokens: ${totals.outputTokens}`);
process.exit(failed === 0 ? 0 : 1);
