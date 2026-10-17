import { z } from 'zod';
import { SupabaseStore } from '../src/data/supabaseStore.js';
import { endpoint, HttpError, json, readBody } from '../src/server/http.js';
import { checkLimits, ipHash, startUsage } from '../src/server/limits.js';
import { MAX_RESUME_CHARS } from '../src/server/resume.js';
import { getState, requireSandbox } from '../src/server/sandbox.js';
import { runScreening } from '../src/server/screening.js';

const Body = z.object({ sandboxId: z.uuid(), applicantId: z.string().trim().min(1).max(20) });

// Retries a screening that didn't finish. The resume text was checked when it was uploaded and
// never leaves the server.
export const POST = endpoint('screen', async (request) => {
  const { sandboxId, applicantId } = await readBody(request, Body);
  await requireSandbox(sandboxId);
  const store = new SupabaseStore(sandboxId);
  const [applicant, record, resumeText, stored] = await Promise.all([
    store.getApplicant(applicantId),
    store.getScreening(applicantId),
    store.getResumeText(applicantId),
    store.getResumeSource(applicantId),
  ]);
  if (!applicant || !record) throw new HttpError(404, 'That applicant is not in this sandbox.');
  if (!resumeText) throw new HttpError(400, 'This applicant has no resume to screen.');
  if (record.screening) throw new HttpError(409, 'This resume has already been screened.');

  const ip = ipHash(request);
  await checkLimits(sandboxId, ip);
  const usageId = await startUsage(sandboxId, ip, 'screening');
  // The facts recorded at upload. Only a resume uploaded before they were recorded falls back to
  // the stored text, where a full 20,000 characters means it was cut (or was exactly that long).
  const source = stored ?? { truncated: resumeText.length >= MAX_RESUME_CHARS, originalChars: null };
  await store.clearScreening(applicantId, source);
  const screening = await runScreening(sandboxId, applicant.id, applicant.role, resumeText, source, usageId, 'retry');
  return json({
    screening: { ok: screening.ok },
    usage: screening.usage,
    responseIds: screening.responseIds,
    state: await getState(sandboxId),
  });
});
