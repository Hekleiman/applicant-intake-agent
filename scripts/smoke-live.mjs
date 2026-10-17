// End-to-end check of the live sandbox API. Runs the whole flow against a base URL and asserts
// each result, then checks the database directly with the secret key.
//
//   node --env-file=.env scripts/smoke-live.mjs http://localhost:3000
//
// Needs DEMO_PASSCODE, SUPABASE_URL, SUPABASE_SECRET_KEY and OPENAI_API_KEY (to check that
// responses were not stored). Makes real model calls.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const code = process.env.DEMO_PASSCODE;
if (!code || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !process.env.OPENAI_API_KEY) {
  console.error('DEMO_PASSCODE, SUPABASE_URL, SUPABASE_SECRET_KEY and OPENAI_API_KEY must be set.');
  process.exit(2);
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SSN = '123-45-6789';
let passed = 0;
let failed = 0;
const totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
let loggedRequests = 0; // chat, approval and screening requests that reached the model step
const responseIds = new Set(); // OpenAI response IDs seen in turn and screening responses

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
  for (const id of json?.responseIds ?? []) responseIds.add(id);
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

const samples = JSON.parse(readFileSync(new URL('../docs/samples/samples.json', import.meta.url), 'utf8'));
const sampleFile = (file, ext) => ({
  filename: `${file}.${ext}`,
  contentType: ext === 'pdf' ? 'application/pdf' : 'text/plain',
  base64: readFileSync(new URL(`../docs/samples/${file}.${ext}`, import.meta.url)).toString('base64'),
});
const audit = (r) => (r.json?.state?.audit ?? []).map((e) => e.text);
const laToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
let lastState = null;

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
assert('Devon Park starts in Interview scheduled with a booking for Wednesday 09:30',
  created.json.state.applicants.find((a) => a.name === 'Devon Park')?.stage === 'interview_scheduled' &&
    created.json.state.bookings.length === 1 && created.json.state.bookings[0].slot === 'Wed 09:30' &&
    created.json.state.bookings[0].applicantId === 'A-1002' && !created.json.state.openSlots.includes('Wed 09:30'),
  JSON.stringify(created.json.state.bookings));

// 2b. Seed version: a new sandbox is on the current seed; one created before the current seed went
// live reports the older version, which the page replaces with a fresh sandbox.
{
  const st = created.json.state;
  assert(`a new sandbox reports seed version ${st.seedVersion} of ${st.currentSeedVersion}`,
    Number.isInteger(st.currentSeedVersion) && st.currentSeedVersion >= 2 && st.seedVersion === st.currentSeedVersion,
    JSON.stringify({ seedVersion: st.seedVersion, currentSeedVersion: st.currentSeedVersion }));
  const old = (await call('POST', '/api/sandbox', {})).json?.sandboxId;
  await db.from('sandboxes').update({ created_at: '2026-10-16T23:00:00Z' }).eq('id', old);
  const r = await call('GET', `/api/state?sandboxId=${old}`);
  assert('a sandbox created before seed version 2 went live (2026-10-16 23:00 UTC) reports seed version 1',
    r.status === 200 && r.json.state.seedVersion === 1 && r.json.state.currentSeedVersion === st.currentSeedVersion,
    JSON.stringify({ status: r.status, seedVersion: r.json?.state?.seedVersion }));
  await db.from('sandboxes').delete().eq('id', old);
}

// 2c. The state carries the open roles and the general criteria from src/data/roles.ts.
const OPEN_ROLE_NAMES = ['Executive Assistant', 'Recruiter', 'Bookkeeper', 'Caregiver'];
{
  const st = created.json.state;
  const roles = st.roles ?? [];
  const complete = roles.every((r) => typeof r.name === 'string' && r.mustHave?.length >= 1 && r.niceToHave?.length >= 1 &&
    r.mustHave.every((t) => typeof t === 'string') && r.niceToHave.every((t) => typeof t === 'string'));
  assert(`the state lists the four open roles with their criteria (${roles.map((r) => `${r.name}: ${r.mustHave?.length} must, ${r.niceToHave?.length} nice`).join('; ')}) plus the general criteria`,
    JSON.stringify(roles.map((r) => r.name)) === JSON.stringify(OPEN_ROLE_NAMES) && complete &&
      roles.find((r) => r.name === 'Caregiver')?.mustHave.some((t) => /CPR/.test(t)) &&
      st.generalCriteria?.mustHave?.length >= 1 && st.generalCriteria?.niceToHave?.length >= 1,
    JSON.stringify({ roles, general: st.generalCriteria }));
}

// 3. Add applicants
{
  const r = await call('POST', '/api/applicants', { sandboxId, name: 'Jordan Lee', role: 'Executive Assistant', notes: 'Added by the smoke test.' });
  assert('adding "Jordan Lee, Executive Assistant" works',
    r.status === 200 && r.json.applicant.id === 'A-1006' && r.json.applicant.stage === 'applied' && applicant(r, 'Jordan Lee'),
    JSON.stringify(r.json));
  assert(`Jordan Lee's applied date is today in Los Angeles (${laToday})`, r.json?.applicant?.appliedOn === laToday,
    `appliedOn=${r.json?.applicant?.appliedOn}`);
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
  const labelled = toolCalls(r, 'book_interview').some((e) => e.data.output?.label === 'Monday at 10:00 AM');
  assert('the booking result carries the label "Monday at 10:00 AM" and the reply uses it, not "Mon 10:00"',
    labelled && /Monday/.test(r.json?.reply ?? '') && !/\bMon 10:00\b/.test(r.json?.reply ?? ''), brief(r));
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

// 9b. Resume upload and screening: PDF for two samples, .txt for two.
const uploaded = {};
{
  const plan = [
    ['caregiver-strong', 'pdf'],
    ['recruiter-injection', 'pdf'],
    ['executive-assistant-weak', 'txt'],
    ['bookkeeper-inconsistent', 'txt'],
  ];
  for (const [file, ext] of plan) {
    const sample = samples.find((x) => x.file === file);
    const r = await call('POST', '/api/applicants', { sandboxId, name: sample.name, role: sample.role, resume: sampleFile(file, ext) });
    if (r.status === 200) loggedRequests++;
    const id = r.json?.applicant?.id;
    const view = id && r.json.state.screenings?.[id];
    const s = view?.result;
    uploaded[file] = { id, name: sample.name, screening: s };
    const expected = {
      'caregiver-strong': () => s.fit !== 'weak',
      'executive-assistant-weak': () => s.fit !== 'strong',
      'bookkeeper-inconsistent': () => s.concerns.some((c) => /date|overlap|graduat|timeline|concurrent|same time/i.test(`${c.issue} ${c.evidence}`)),
      'recruiter-injection': () => s.injectionAttempt === true && s.fit !== 'strong',
    }[file];
    const advisory = applicant(r, sample.name)?.stage === 'applied' && !(r.json?.state?.pendingApprovals ?? []).length;
    const activity = audit(r).some((t) => t.startsWith(`Screened ${sample.name}'s resume: `) && /: (strong fit|partial fit|weak fit|not enough information), \d+ things? to verify/.test(t));
    assert(`uploading ${file}.${ext} adds ${sample.name} and screens it (fit ${s?.fit}, concerns ${s?.concerns?.length}, injectionAttempt ${s?.injectionAttempt}); stays in Applied; Activity says "Screened ${sample.name}'s resume: ..."`,
      r.status === 200 && r.json.screening?.ok === true && view?.status === 'done' && s && expected() && advisory && activity && r.json.usage?.requests >= 1,
      `status=${r.status} error=${r.json?.error} view=${JSON.stringify(view)?.slice(0, 300)} activity=${JSON.stringify(audit(r).slice(-2))}`);
  }
}

// 9b2. A resume over 20,000 characters is cut, and the screening says so. truncated and
// originalChars are set by the server, not the model.
const LONG_NAME = 'Avery Quinn';
{
  const file = sampleFile('caregiver-long', 'txt');
  const rawChars = Buffer.from(file.base64, 'base64').toString('utf8').length;
  const r = await call('POST', '/api/applicants', { sandboxId, name: LONG_NAME, role: 'Caregiver', resume: file });
  if (r.status === 200) loggedRequests++;
  const id = r.json?.applicant?.id;
  const view = id && r.json.state.screenings?.[id];
  const s = view?.result;
  const { data: row } = await db.from('applicants').select('resume_text').eq('sandbox_id', sandboxId).eq('id', id ?? '').maybeSingle();
  assert(`uploading caregiver-long.txt (${rawChars} characters) screens it with truncated: true and originalChars ${s?.originalChars}; 20,000 characters stored`,
    r.status === 200 && view?.status === 'done' && s?.truncated === true && typeof s.originalChars === 'number' &&
      s.originalChars > 20000 && s.originalChars <= rawChars && row?.resume_text?.length === 20000 &&
      applicant(r, LONG_NAME)?.stage === 'applied',
    `status=${r.status} error=${r.json?.error} truncated=${s?.truncated} originalChars=${s?.originalChars} stored=${row?.resume_text?.length}`);
  const line = audit(r).find((t) => t.startsWith(`Screened ${LONG_NAME}'s resume: `));
  assert(`Activity for the long resume reads "${line}"`,
    !!line && /: (strong fit|partial fit|weak fit|not enough information), \d+ things? to verify.* \(only the first part was screened\)\.$/.test(line),
    JSON.stringify(audit(r).slice(-2)));
  const short = Object.values(uploaded).map((u) => u.screening?.truncated);
  assert('the four sample resumes under 20,000 characters are saved with truncated: false',
    short.length === 4 && short.every((t) => t === false), JSON.stringify(short));
}

// 9b3. The details panel wording, as served.
{
  const res = await fetch(`${base}/live.html`);
  const html = await res.text();
  assert('the details panel has the truncation notice "This resume was longer than 20,000 characters, so only the first part was screened."',
    res.status === 200 && html.includes('This resume was longer than 20,000 characters, so only the first part was screened.'), `status=${res.status}`);
  assert('the injection flag reads "This resume contains text aimed at an AI. The screener has no tools, ..." and no longer says it was ignored',
    html.includes("This resume contains text aimed at an AI. The screener has no tools, so that text couldn't make it change anything. It could still have influenced the rating, so check the evidence below.") &&
      !/was ignored|nothing was changed because of it/i.test(html), `status=${res.status}`);
}

// 9c. An SSN-shaped value in a resume is refused before any model call, and nothing is added.
{
  const before = await usageCount((q) => q.eq('sandbox_id', sandboxId));
  const countBefore = (await call('GET', `/api/state?sandboxId=${sandboxId}`)).json.state.applicants.length;
  const text = `Pat Doe\nBookkeeper\nSSN: ${SSN}\nFive years of bookkeeping in QuickBooks.\n`;
  const r = await call('POST', '/api/applicants', {
    sandboxId, name: 'Pat Doe', role: 'Bookkeeper',
    resume: { filename: 'pat-doe.txt', contentType: 'text/plain', base64: Buffer.from(text).toString('base64') },
  });
  const after = await usageCount((q) => q.eq('sandbox_id', sandboxId));
  const state = await call('GET', `/api/state?sandboxId=${sandboxId}`);
  const { count: rows } = await db.from('applicants').select('id', { count: 'exact', head: true }).eq('sandbox_id', sandboxId).eq('name', 'Pat Doe');
  assert('a resume containing 123-45-6789 is refused with 0 model requests and no applicant row',
    r.status === 400 && !r.json?.usage && after === before && state.json.state.applicants.length === countBefore && rows === 0,
    `status=${r.status} error=${r.json?.error} usage rows ${before} -> ${after} applicants ${countBefore} -> ${state.json.state.applicants.length} rows=${rows}`);
}

// 9d. The chat agents read the screening only through get_screening.
{
  const casey = uploaded['recruiter-injection'];
  const r = await chat(sandboxId, `What did the screen find for ${casey.name}?`);
  const calls = toolCalls(r, 'get_screening');
  const out = calls.find((e) => e.data.output?.found)?.data.output;
  assert(`"What did the screen find for ${casey.name}?" answers with get_screening (fit ${out?.fit}) and changes nothing`,
    r.status === 200 && out && out.fit === casey.screening?.fit && !('resumeText' in out) && /fit|screen/i.test(r.json.reply) &&
      applicant(r, casey.name)?.stage === 'applied' && !r.json.pendingApproval,
    brief(r));
  lastState = r.json?.state;
}

// 9e. Roles: a listed role typed in any case is saved under its canonical name and screened against
// that role; anything else is saved as typed and screened with the general criteria.
{
  const r = await call('POST', '/api/applicants', { sandboxId, name: 'Riley Shaw', role: 'caregiver', resume: sampleFile('caregiver-strong', 'txt') });
  if (r.status === 200) loggedRequests++;
  const s = r.json?.state?.screenings?.[r.json?.applicant?.id]?.result;
  assert(`adding with role "caregiver" saves "${r.json?.applicant?.role}" and screens against the Caregiver criteria (screening role ${s?.role}, generalCriteria ${s?.generalCriteria})`,
    r.status === 200 && r.json.applicant.role === 'Caregiver' && applicant(r, 'Riley Shaw')?.role === 'Caregiver' &&
      s?.role === 'Caregiver' && s.generalCriteria === false,
    `status=${r.status} error=${r.json?.error} role=${r.json?.applicant?.role} screening=${JSON.stringify(s)?.slice(0, 200)}`);

  const o = await call('POST', '/api/applicants', { sandboxId, name: 'Quinn Harper', role: 'Office Manager', resume: sampleFile('executive-assistant-weak', 'txt') });
  if (o.status === 200) loggedRequests++;
  const g = o.json?.state?.screenings?.[o.json?.applicant?.id]?.result;
  assert(`adding with role "Office Manager" saves it as typed and screens with the general criteria (screening role ${g?.role}, generalCriteria ${g?.generalCriteria})`,
    o.status === 200 && o.json.applicant.role === 'Office Manager' && g?.role === 'Office Manager' && g.generalCriteria === true,
    `status=${o.status} error=${o.json?.error} screening=${JSON.stringify(g)?.slice(0, 200)}`);
}

// 9f. Role questions in chat use get_role_requirements and change nothing.
{
  const snapshot = (st) => JSON.stringify({ a: st?.applicants?.map((a) => [a.id, a.role, a.stage]), b: st?.bookings, n: st?.audit?.length });
  const before = snapshot((await call('GET', `/api/state?sandboxId=${sandboxId}`)).json?.state);

  const r = await chat(sandboxId, 'What does the Caregiver role require?');
  const out = toolCalls(r, 'get_role_requirements').map((e) => e.data.output).find((o) => o?.role === 'Caregiver');
  assert('"What does the Caregiver role require?" uses get_role_requirements (Caregiver, not general), keeps the verify note and changes nothing',
    r.status === 200 && out && out.general === false && /CPR/i.test(r.json.reply) &&
      out.mustHave?.some((c) => c.verifyNote) && /verif/i.test(r.json.reply) && !r.json.pendingApproval &&
      snapshot(r.json.state) === before,
    brief(r));
  console.log(`      reply: ${JSON.stringify(r.json?.reply)}`);

  const o = await chat(sandboxId, 'What roles are open?');
  const used = toolCalls(o, 'get_role_requirements');
  const reply = o.json?.reply ?? '';
  const INVENTED = /\b(software|engineer|developer|nurse|accountant|office manager|marketing|sales|designer|analyst|receptionist|administrative assistant|project manager|customer service)\b/i;
  assert('"What roles are open?" uses get_role_requirements and lists exactly the four roles, no invented ones',
    o.status === 200 && used.length > 0 && OPEN_ROLE_NAMES.every((n) => reply.toLowerCase().includes(n.toLowerCase())) &&
      !INVENTED.test(reply) && !o.json.pendingApproval && snapshot(o.json.state) === before,
    brief(o));
  console.log(`      reply: ${JSON.stringify(reply)}`);
}

// 10. Isolation
let otherId;
{
  const other = await call('POST', '/api/sandbox', {});
  otherId = other.json?.sandboxId;
  const r = await call('GET', `/api/state?sandboxId=${otherId}`);
  assert('a second sandbox can\'t see Jordan Lee (isolation)',
    other.status === 200 && otherId !== sandboxId && r.status === 200 && !applicant(r, 'Jordan Lee') &&
      r.json.state.applicants.length === 5 && r.json.state.bookings.length === 1 && r.json.state.bookings[0].applicantId === 'A-1002',
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
  assert('usage_log has one row per chat, approval or screening request',
    !e3 && usage.length === loggedRequests && sum === totals.requests,
    e3?.message ?? `${usage?.length} rows for ${loggedRequests} requests; logged model requests ${sum} vs reported ${totals.requests}`);
}

// 12. Resume text never reaches the chat agents' session.
{
  const { data: items, error } = await db.from('session_items').select('item').eq('sandbox_id', sandboxId);
  const all = JSON.stringify(items ?? []);
  const found = samples.filter((x) => all.includes(x.distinctive)).map((x) => x.file);
  assert(`no session_items row contains a distinctive line from any sample resume (${items?.length} rows checked)`,
    !error && items.length > 0 && found.length === 0 && all.includes('get_screening'),
    error?.message ?? `found: ${found.join(', ')}`);
}

// 13. store: false holds: OpenAI can't return any response this run created.
{
  const ids = [...responseIds];
  const statuses = [];
  for (const id of ids) {
    const res = await fetch(`https://api.openai.com/v1/responses/${id}`, { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    statuses.push(res.status);
  }
  assert(`none of the ${ids.length} OpenAI responses from this run can be retrieved (GET /v1/responses/{id} returns 404)`,
    ids.length >= 10 && statuses.every((s) => s === 404),
    `statuses: ${statuses.join(',')}`);
}

// 14. A reload returns the conversation: user and assistant text only, in order.
{
  const r = await call('GET', `/api/state?sandboxId=${sandboxId}`);
  const conv = r.json?.state?.conversation ?? [];
  const firstUser = conv.findIndex((m) => m.role === 'user' && m.text === 'Where is Jordan Lee in the hiring process?');
  const onlyText = conv.every((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && Object.keys(m).length === 2);
  assert(`a reload returns the conversation (${conv.length} messages, user and assistant text only, in order)`,
    r.status === 200 && firstUser === 0 && conv[1]?.role === 'assistant' && onlyText &&
      conv.some((m) => m.role === 'user' && m.text.startsWith('What did the screen find')) && !conv.some((m) => m.text.includes(SSN)),
    JSON.stringify(conv.slice(0, 4)));
  lastState = r.json?.state;
}

// 15. Activity wording.
{
  const texts = (lastState?.audit ?? []).map((e) => e.text);
  const has = (t) => texts.includes(t);
  assert('Activity: "Moved Jordan Lee from Applied to Phone screen."', has('Moved Jordan Lee from Applied to Phone screen.'), JSON.stringify(texts));
  assert('Activity: "The assistant asked to make Jordan Lee an offer."', has('The assistant asked to make Jordan Lee an offer.'), JSON.stringify(texts));
  assert('Activity: "Booked an interview for Jordan Lee: Monday at 10:00 AM."', has('Booked an interview for Jordan Lee: Monday at 10:00 AM.'), JSON.stringify(texts));
  assert('Activity: "A recruiter approved the offer for Jordan Lee." (written once the decision took effect)', has('A recruiter approved the offer for Jordan Lee.'), JSON.stringify(texts));
  assert('Activity: "A recruiter declined the rejection of Devon Park." (written once the decision took effect)', has('A recruiter declined the rejection of Devon Park.'), JSON.stringify(texts));
  const approvedAt = texts.indexOf('A recruiter approved the offer for Jordan Lee.');
  const movedAt = texts.indexOf('Moved Jordan Lee from Interview scheduled to Offer.');
  const askedAt = texts.indexOf('The assistant asked to make Jordan Lee an offer.');
  assert('Activity reads requested, approved, result: the offer request, then the approval, then the move to Offer',
    askedAt >= 0 && askedAt < approvedAt && approvedAt < movedAt, JSON.stringify(texts));
  const reject = texts.find((t) => t.startsWith('The assistant asked to reject Devon Park'));
  assert(`Activity: the rejection request reads "${reject}" with no doubled punctuation`,
    !!reject && /^The assistant asked to reject Devon Park \(.*[^.!?]\)\.$/.test(reject) && !texts.some((t) => /\.\.|[.!?]\)\./.test(t)),
    JSON.stringify(texts));
}

// Clean up both sandboxes (everything in them cascades).
await db.from('sandboxes').delete().in('id', [sandboxId, otherId]);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`Model requests: ${totals.requests}, input tokens: ${totals.inputTokens}, output tokens: ${totals.outputTokens}`);
process.exit(failed === 0 ? 0 : 1);
