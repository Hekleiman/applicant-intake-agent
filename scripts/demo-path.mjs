// Runs, on a fresh sandbox, exactly what a live demo does, in order, and checks after every step
// that nothing on the page would look wrong: Activity in true order, no doubled punctuation, no
// raw stage keys or slot codes, and no "undefined", "null" or "NaN" in replies, Activity or the
// board. Prints every reply.
//
//   node --env-file=.env scripts/demo-path.mjs http://localhost:3000
//
// Needs DEMO_PASSCODE. With SUPABASE_URL and SUPABASE_SECRET_KEY it also deletes its sandbox at
// the end. Makes real model calls (about 20 requests, all counted toward the limits).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const code = process.env.DEMO_PASSCODE;
if (!code) {
  console.error('DEMO_PASSCODE must be set.');
  process.exit(2);
}

// The same lists the page uses: the starter prompts in docs/live.html and the sample buttons
// from docs/samples/samples.json (the buttons load the PDFs).
const html = readFileSync(new URL('../docs/live.html', import.meta.url), 'utf8');
const STARTERS = JSON.parse(
  `[${/var STARTERS = \[([\s\S]*?)\];/.exec(html)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`,
);
const samples = JSON.parse(readFileSync(new URL('../docs/samples/samples.json', import.meta.url), 'utf8'));

let passed = 0;
let failed = 0;
const replies = [];

function assert(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-code': code },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

// What the page shows on the board: names, roles, notes, stage column titles, booking times and
// screening badges and summaries (the page turns slot codes into labels itself).
const STAGE_TITLES = { applied: 'Applied', phone_screen: 'Phone screen', interview_scheduled: 'Interview scheduled', offer: 'Offer', rejected: 'Rejected' };
function boardTexts(state) {
  const out = [];
  for (const a of state.applicants) {
    out.push(a.name, a.role, a.notes, a.appliedOn, STAGE_TITLES[a.stage] ?? `unknown stage ${a.stage}`);
    const s = state.screenings?.[a.id]?.result;
    if (s) out.push(s.summary, ...s.toVerify, ...s.concerns.flatMap((c) => [c.issue, c.evidence]), String(s.yearsRelevantExperience ?? ''));
  }
  return out;
}

const BAD_WORDS = /\b(undefined|null|NaN)\b/;
const DOUBLED = /(?<!\.)\.\.(?!\.)|[.!?]\)\.|,,|[!?]\.|\.[!?]|\(\s*\)/;
const RAW_STAGE = /\b(phone_screen|interview_scheduled|insufficient_info|not_met)\b/;
const RAW_SLOT = /\b(Mon|Tue|Wed|Thu|Fri) \d{1,2}:\d{2}\b/;

let state = null;
let previousAudit = [];

// After every step: the page's three surfaces read cleanly, and Activity is in true order.
function checkPage(step, reply) {
  const audit = state.audit ?? [];
  const lines = audit.map((e) => e.text);
  const texts = [...(reply === undefined ? [] : [reply]), ...lines, ...boardTexts(state)];
  const bad = texts.filter((t) => BAD_WORDS.test(String(t)));
  const doubled = [...(reply === undefined ? [] : [reply]), ...lines].filter((t) => DOUBLED.test(t));
  const stageKeys = [...(reply === undefined ? [] : [reply]), ...lines].filter((t) => RAW_STAGE.test(t));
  const slots = [...(reply === undefined ? [] : [reply]), ...lines].filter((t) => RAW_SLOT.test(t));
  // True order: times never go backwards, the earlier lines are unchanged, and every decision
  // sits between its request and its result.
  const times = audit.map((e) => Date.parse(e.at));
  const monotonic = times.every((t, i) => i === 0 || t >= times[i - 1]);
  const kept = previousAudit.every((t, i) => lines[i] === t) || lines.length >= 30;
  const orderProblems = [];
  for (const [i, e] of audit.entries()) {
    if (e.action !== 'approved' && e.action !== 'declined') continue;
    const offer = /\boffer\b/.test(e.detail);
    const reqIdx = audit.findIndex((x, j) => j < i && x.applicantId === e.applicantId && x.action === (offer ? 'offer_requested' : 'rejection_requested'));
    if (reqIdx < 0) orderProblems.push(`no request before "${e.text}"`);
    if (e.action === 'approved') {
      const resultIdx = audit.findIndex((x) => x.applicantId === e.applicantId &&
        (offer ? x.action === 'stage_changed' && x.detail.endsWith('-> offer') : x.action === 'rejected'));
      if (resultIdx >= 0 && resultIdx < i) orderProblems.push(`"${audit[resultIdx].text}" comes before "${e.text}"`);
    }
  }
  assert(`${step}: Activity in true order (${lines.length} lines, times never go back, decision between request and result)`,
    monotonic && kept && orderProblems.length === 0, JSON.stringify({ monotonic, kept, orderProblems, lines }));
  assert(`${step}: no doubled punctuation in the reply or Activity`, doubled.length === 0, JSON.stringify(doubled));
  assert(`${step}: no raw stage keys in the reply or Activity`, stageKeys.length === 0, JSON.stringify(stageKeys));
  assert(`${step}: no raw slot codes in the reply or Activity`, slots.length === 0, JSON.stringify(slots));
  assert(`${step}: no "undefined", "null" or "NaN" in the reply, Activity or the board`, bad.length === 0, JSON.stringify(bad));
  previousAudit = lines;
}

const record = (step, r) => {
  const reply = r.json?.reply ?? '';
  replies.push({ step, status: r.status, reply });
  if (r.json?.state) state = r.json.state;
  return reply;
};

async function chat(step, message) {
  const r = await call('POST', '/api/chat', { sandboxId, message });
  const reply = record(`${step}: "${message}"`, r);
  assert(`${step}: "${message}" answers (200)`, r.status === 200 && reply.length > 0, `status=${r.status} error=${r.json?.error}`);
  checkPage(step, reply);
  return r;
}

async function decide(step, r, approve, what) {
  const pending = r.json?.pendingApproval;
  const ok = pending?.interruptions?.length > 0;
  assert(`${step}: ${what} is waiting for approval`, ok, JSON.stringify(r.json?.pendingApproval ?? r.json?.error));
  if (!ok) return null;
  const d = await call('POST', '/api/approvals', {
    sandboxId,
    pausedRunId: pending.pausedRunId,
    decisions: pending.interruptions.map((i) => ({ callId: i.callId, approve })),
  });
  const reply = record(`${step}: ${approve ? 'Approve' : 'Decline'} (${what})`, d);
  assert(`${step}: ${approve ? 'approving' : 'declining'} ${what} answers (200), nothing left pending`,
    d.status === 200 && reply.length > 0 && !d.json.pendingApproval && (d.json.state?.pendingApprovals ?? []).length === 0,
    `status=${d.status} error=${d.json?.error}`);
  checkPage(step, reply);
  return d;
}

const stageOf = (name) => state.applicants.find((a) => a.name === name)?.stage;

console.log(`Demo path against ${base}\n`);

// A fresh sandbox, on the current seed.
const created = await call('POST', '/api/sandbox', {});
const sandboxId = created.json?.sandboxId;
state = created.json?.state;
assert('a fresh sandbox on the current seed, 5 applicants, Devon booked',
  created.status === 200 && created.json.created === true && state?.seedVersion === state?.currentSeedVersion &&
    state.applicants.length === 5 && state.bookings.length === 1,
  JSON.stringify({ status: created.status, seed: state?.seedVersion, current: state?.currentSeedVersion }));
if (!sandboxId) process.exit(1);
checkPage('start');

// a. Each sample button's file.
for (const sample of samples) {
  const file = {
    filename: `${sample.file}.pdf`,
    contentType: 'application/pdf',
    base64: readFileSync(new URL(`../docs/samples/${sample.file}.pdf`, import.meta.url)).toString('base64'),
  };
  const r = await call('POST', '/api/applicants', { sandboxId, name: sample.name, role: sample.role, notes: '', resume: file });
  if (r.json?.state) state = r.json.state;
  const id = r.json?.applicant?.id;
  const view = id && state.screenings?.[id];
  assert(`a. "${sample.label ?? `${sample.role} (${sample.name})`}" adds ${sample.name} and screens the PDF (fit ${view?.result?.fit}${view?.result?.truncated ? ', first part only' : ''})`,
    r.status === 200 && r.json.screening?.ok === true && view?.status === 'done' &&
      (sample.file === 'caregiver-long') === (view.result.truncated === true),
    `status=${r.status} error=${r.json?.error} view=${JSON.stringify(view)?.slice(0, 200)}`);
  checkPage(`a. ${sample.file}`);
}

// b. Each starter prompt, as clicked. The offer and the rejection pause; in the demo the offer is
// approved and the rejection declined before the next prompt.
for (const [i, prompt] of STARTERS.entries()) {
  const step = `b${i + 1}`;
  const r = await chat(step, prompt);
  if (/offer/i.test(prompt)) await decide(step, r, true, `the offer for Maria Lopez`);
  if (/^Reject/i.test(prompt)) await decide(step, r, false, 'the rejection of Devon Park');
}
assert('b: after the starters Maria is in Offer, Priya in Interview scheduled, Devon still in Interview scheduled',
  stageOf('Maria Lopez') === 'offer' && stageOf('Priya Natarajan') === 'interview_scheduled' && stageOf('Devon Park') === 'interview_scheduled',
  JSON.stringify(state.applicants.map((a) => `${a.name}: ${a.stage}`)));

// c. The screening question.
{
  const r = await chat('c', 'What did the screen find for Casey Lin?');
  assert('c: answered from get_screening, Casey still in Applied',
    (r.json?.events ?? []).some((e) => e.type === 'tool_call' && e.data.tool === 'get_screening' && e.data.output?.found) &&
      stageOf('Casey Lin') === 'applied',
    JSON.stringify(r.json?.events?.map((e) => e.data?.tool ?? e.type)));
}

// d. Priya to phone screen and booked (the starters already did both, so this checks that the
// repeat reads well too).
await chat('d', 'Move Priya to phone screen');
await chat('d', 'Book Priya for the first open slot');
assert('d: Priya is in Interview scheduled with exactly one booking',
  stageOf('Priya Natarajan') === 'interview_scheduled' && state.bookings.filter((b) => b.applicantId === 'A-1003').length === 1,
  JSON.stringify(state.bookings));

// e. An offer, approved.
{
  const r = await chat('e', 'Make Priya Natarajan an offer');
  await decide('e', r, true, 'the offer for Priya Natarajan');
  assert('e: Priya is in Offer', stageOf('Priya Natarajan') === 'offer', stageOf('Priya Natarajan'));
}

// f. Devon rejected, declined.
{
  const r = await chat('f', 'Reject Devon Park, the role was filled');
  await decide('f', r, false, 'the rejection of Devon Park');
  assert('f: Devon is still in Interview scheduled with his booking',
    stageOf('Devon Park') === 'interview_scheduled' && state.bookings.some((b) => b.applicantId === 'A-1002'),
    JSON.stringify(state.bookings));
}

// g. A reload.
{
  const r = await call('GET', `/api/state?sandboxId=${sandboxId}`);
  const before = previousAudit;
  if (r.json?.state) state = r.json.state;
  const conv = state.conversation ?? [];
  assert(`g: a reload returns the same Activity and the conversation (${conv.length} messages)`,
    r.status === 200 && JSON.stringify(state.audit.map((e) => e.text)) === JSON.stringify(before) &&
      conv[0]?.text === STARTERS[0] && !conv.some((m) => BAD_WORDS.test(m.text)),
    `status=${r.status}`);
  checkPage('g');
}

console.log('\nActivity after the run, oldest first:');
for (const e of state.audit) console.log(`  ${e.at}  ${e.text}`);
console.log('\nReplies:');
for (const r of replies) console.log(`\n[${r.step}] (${r.status})\n${r.reply}`);

if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  await db.from('sandboxes').delete().eq('id', sandboxId);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
