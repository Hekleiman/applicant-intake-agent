import { z } from 'zod';
import { SupabaseStore } from '../src/data/supabaseStore.js';
import { findPolicyViolation } from '../src/guardrails/piiGuardrail.js';
import { endpoint, HttpError, json, readBody } from '../src/server/http.js';
import { checkLimits, ipHash, startUsage } from '../src/server/limits.js';
import { extractResumeText, MAX_RESUME_CHARS, ResumeUpload } from '../src/server/resume.js';
import { getState, MAX_APPLICANTS, requireSandbox } from '../src/server/sandbox.js';
import { runScreening } from '../src/server/screening.js';

const Body = z.object({
  sandboxId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(500).default(''),
  stage: z.literal('applied').default('applied'),
  resume: ResumeUpload.optional(),
});

// Adds an applicant from the form, optionally with a resume. The code checks run first: the
// resume's text is extracted here and checked with the same findPolicyViolation rule as the chat
// guardrail, so an SSN-shaped value is refused before any model sees anything. Only then is the
// applicant added and the resume text sent to the Screener, an agent with no tools. Without a
// resume there is no model call.
export const POST = endpoint('applicants', async (request) => {
  const body = await readBody(request, Body);
  const resume = body.resume ? await extractResumeText(body.resume) : null;
  const resumeText = resume?.text ?? null;
  for (const [field, value] of [['name', body.name], ['role', body.role], ['notes', body.notes]] as const) {
    if (findPolicyViolation(value)) {
      throw new HttpError(400, `The ${field} looks like it contains a Social Security number or other sensitive ID. Please remove it.`);
    }
  }
  if (resumeText !== null && findPolicyViolation(resumeText, MAX_RESUME_CHARS)) {
    throw new HttpError(400, "The resume looks like it contains a Social Security number or other sensitive ID, so it wasn't sent to the AI. Remove it and upload the resume again.");
  }

  await requireSandbox(body.sandboxId);
  const store = new SupabaseStore(body.sandboxId);
  if ((await store.listApplicants()).length >= MAX_APPLICANTS) {
    throw new HttpError(409, `A sandbox can hold at most ${MAX_APPLICANTS} applicants. Use Start over to begin again.`);
  }
  const ip = resumeText !== null ? ipHash(request) : null;
  if (ip) await checkLimits(body.sandboxId, ip);

  const applicant = await store.addApplicant({ name: body.name, role: body.role, notes: body.notes, resumeText });
  await store.addAudit(applicant.id, 'added', `${applicant.name}, ${applicant.role}`);

  let screening = null;
  if (resume && ip) {
    const usageId = await startUsage(body.sandboxId, ip, 'screening');
    screening = await runScreening(body.sandboxId, applicant.id, applicant.role, resume.text, { truncated: resume.truncated, originalChars: resume.originalChars }, usageId);
  }
  return json({
    applicant,
    screening: screening && { ok: screening.ok },
    usage: screening?.usage,
    responseIds: screening?.responseIds,
    state: await getState(body.sandboxId),
  });
});
