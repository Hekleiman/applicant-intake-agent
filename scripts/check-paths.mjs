// Checks the approval paths' Activity order, usage on the recovery path and the screening retry,
// against a local server. Each mode needs the server started with its test hook (read only
// outside production):
//
//   vercel dev                                    -> node --env-file=.env scripts/check-paths.mjs URL order
//   LIVE_TEST_FAIL_RESUME=after_decision vercel dev -> ... recovery
//   LIVE_TEST_FAIL_RESUME=audit_write vercel dev    -> ... audit-write
//   LIVE_TEST_FAIL_SCREENING=upload vercel dev      -> ... retry
//
// order: offer approved, rejection approved and rejection declined, each with its Activity lines.
// recovery: an approved rejection whose reply fails after the tool ran.
// audit-write: an approved rejection whose run finishes but whose audit write fails; the usage
// row must still carry the run's model requests.
// retry: a resume over 20,000 characters and one of exactly 20,000, each failing at upload and
// then retried; the retry must keep the truncation facts recorded at upload.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const [base = 'http://localhost:3000', mode = 'order'] = process.argv.slice(2);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
let passed = 0;
let failed = 0;
const sandboxes = [];

function assert(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-code': process.env.DEMO_PASSCODE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const newSandbox = async () => {
  const r = await call('POST', '/api/sandbox', {});
  sandboxes.push(r.json.sandboxId);
  return r.json.sandboxId;
};

const decide = (sandboxId, r, approve) =>
  call('POST', '/api/approvals', {
    sandboxId,
    pausedRunId: r.json.pendingApproval.pausedRunId,
    decisions: r.json.pendingApproval.interruptions.map((i) => ({ callId: i.callId, approve })),
  });

const activity = (state, name) => state.audit.filter((e) => e.text.includes(name));
const show = (lines) => lines.map((e) => `      ${e.at}  ${e.text}`).join('\n');

// requested, decided, result: in this order and with times that never go back.
function checkOrder(label, lines, expected) {
  const texts = lines.map((e) => e.text);
  const times = lines.map((e) => Date.parse(e.at));
  const ordered = times.every((t, i) => i === 0 || t >= times[i - 1]);
  const ok = ordered && expected.length === texts.length && expected.every((re, i) => re.test(texts[i]));
  assert(`${label}: Activity reads ${expected.length} lines in true order`, ok, show(lines));
  console.log(show(lines));
}

async function pause(sandboxId, message) {
  const r = await call('POST', '/api/chat', { sandboxId, message });
  if (!r.json?.pendingApproval) throw new Error(`no approval for "${message}": ${JSON.stringify(r.json)?.slice(0, 300)}`);
  return r;
}

if (mode === 'order') {
  {
    const id = await newSandbox();
    const d = await decide(id, await pause(id, 'Make Maria Lopez an offer'), true);
    checkOrder('offer approved', activity(d.json.state, 'Maria Lopez'), [
      /^The assistant asked to make Maria Lopez an offer\.$/,
      /^A recruiter approved the offer for Maria Lopez\.$/,
      /^Moved Maria Lopez from Phone screen to Offer\.$/,
    ]);
  }
  {
    const id = await newSandbox();
    const d = await decide(id, await pause(id, 'Reject Devon Park, the role was filled'), true);
    checkOrder('rejection approved', activity(d.json.state, 'Devon Park'), [
      /^The assistant asked to reject Devon Park \(.*[^.]\)\.$/,
      /^A recruiter approved the rejection of Devon Park\.$/,
      /^Devon Park is no longer being considered \(.*[^.]\)\.$/,
    ]);
  }
  {
    const id = await newSandbox();
    const d = await decide(id, await pause(id, 'Reject Devon Park, the role was filled'), false);
    checkOrder('rejection declined', activity(d.json.state, 'Devon Park'), [
      /^The assistant asked to reject Devon Park \(.*[^.]\)\.$/,
      /^A recruiter declined the rejection of Devon Park\.$/,
    ]);
  }
}

if (mode === 'recovery' || mode === 'audit-write') {
  const id = await newSandbox();
  const r = await pause(id, 'Reject Sam Rivera, the role was filled');
  const d = await decide(id, r, true);
  assert(`${mode}: the approval answers 200 with the "decision was saved" reply`,
    d.status === 200 && /^Your decision was saved: you approved the rejection of Sam Rivera\./.test(d.json?.reply ?? ''),
    JSON.stringify({ status: d.status, reply: d.json?.reply, error: d.json?.error }));
  checkOrder(`${mode}, rejection approved`, activity(d.json.state, 'Sam Rivera'), [
    /^The assistant asked to reject Sam Rivera \(.*[^.]\)\.$/,
    /^A recruiter approved the rejection of Sam Rivera\.$/,
    /^Sam Rivera is no longer being considered \(.*[^.]\)\.$/,
  ]);
  const { data: rows } = await db.from('usage_log').select('id, kind, model_requests, input_tokens, output_tokens').eq('sandbox_id', id).order('id');
  const approval = rows.filter((u) => u.kind === 'approval').at(-1);
  console.log(`      usage row: ${JSON.stringify(approval)}; response usage: ${JSON.stringify(d.json?.usage)}`);
  if (mode === 'audit-write') {
    assert('audit-write: the usage row records the resumed run\'s model requests and tokens',
      approval?.model_requests >= 1 && approval.input_tokens > 0 && approval.output_tokens > 0 &&
        approval.model_requests === d.json.usage.requests,
      JSON.stringify(approval));
  } else {
    // The hook fails at the first model call, so no request was made; the row must say so, not
    // stay empty by accident.
    assert('recovery: the usage row matches the response (the hook stops the first model call)',
      approval && approval.model_requests === d.json.usage.requests, JSON.stringify(approval));
  }
  const again = await call('POST', '/api/chat', { sandboxId: id, message: 'Where is Maria Lopez in the hiring process?' });
  assert(`${mode}: the next chat message works`, again.status === 200, JSON.stringify(again.json)?.slice(0, 200));
}

if (mode === 'retry') {
  const longFile = readFileSync(new URL('../docs/samples/caregiver-long.txt', import.meta.url));
  // Exactly 20,000 characters after normalization: plain lines, single spaces, no blank runs.
  const line = 'Gave medication reminders on schedule and reported missed doses to the nurse on duty.';
  let exact = 'Riley Exact\nCaregiver with eight years of paid care for older adults.';
  // Leave room for a last "Notes ..." line that brings it to exactly 20,000.
  while (exact.length + 1 + line.length + 10 <= 20000) exact += `\n${line}`;
  exact += `\nNotes ${'a'.repeat(20000 - exact.length - 7)}`;
  const cases = [
    { name: 'Avery Quinn', file: { filename: 'caregiver-long.txt', contentType: 'text/plain', base64: longFile.toString('base64') }, truncated: true },
    { name: 'Riley Exact', file: { filename: 'exact.txt', contentType: 'text/plain', base64: Buffer.from(exact).toString('base64') }, truncated: false, chars: 20000 },
  ];
  console.log(`      exact resume: ${exact.length} characters`);
  const id = await newSandbox();
  for (const c of cases) {
    const up = await call('POST', '/api/applicants', { sandboxId: id, name: c.name, role: 'Caregiver', resume: c.file });
    const aid = up.json?.applicant?.id;
    const { data: row } = await db.from('applicants').select('screening, screened_at, resume_text').eq('sandbox_id', id).eq('id', aid).single();
    assert(`${c.name}: the upload screening fails (hook) and the source block survives: ${JSON.stringify(row.screening)}`,
      up.status === 200 && up.json.screening?.ok === false && up.json.state.screenings[aid]?.status === 'failed' &&
        row.screening?.source?.truncated === c.truncated && row.screening.fit === undefined,
      JSON.stringify({ status: up.status, screening: up.json?.screening, row: row?.screening }));
    const retry = await call('POST', '/api/screen', { sandboxId: id, applicantId: aid });
    const s = retry.json?.state?.screenings?.[aid]?.result;
    const expectChars = c.chars ?? row.screening.source.originalChars;
    assert(`${c.name}: the retry keeps the upload facts (stored ${row.resume_text.length} chars): truncated ${s?.truncated}, originalChars ${s?.originalChars}`,
      retry.status === 200 && retry.json.screening.ok === true && s?.truncated === c.truncated && s.originalChars === expectChars &&
        (c.truncated ? expectChars > 20000 : expectChars === 20000),
      JSON.stringify({ status: retry.status, error: retry.json?.error, truncated: s?.truncated, originalChars: s?.originalChars }));
    const line2 = retry.json?.state?.audit.find((e) => e.text.startsWith(`Screened ${c.name}'s resume`))?.text;
    assert(`${c.name}: Activity reads "${line2}"`,
      !!line2 && /\(only the first part was screened\)\.$/.test(line2) === c.truncated, line2);
  }
}

await db.from('sandboxes').delete().in('id', sandboxes);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
