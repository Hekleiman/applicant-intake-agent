import { z } from 'zod';
import { SupabaseStore } from '../src/data/supabaseStore.js';
import { findPolicyViolation } from '../src/guardrails/piiGuardrail.js';
import { endpoint, HttpError, json, readBody } from '../src/server/http.js';
import { getState, MAX_APPLICANTS, requireSandbox } from '../src/server/sandbox.js';

const Body = z.object({
  sandboxId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(500).default(''),
  stage: z.literal('applied').default('applied'),
});

// Adds an applicant from the form. No model call: the same code-only rule the chat guardrail
// uses refuses SSN-shaped input here too.
export const POST = endpoint('applicants', async (request) => {
  const body = await readBody(request, Body);
  for (const [field, value] of [['name', body.name], ['role', body.role], ['notes', body.notes]] as const) {
    if (findPolicyViolation(value)) {
      throw new HttpError(400, `The ${field} looks like it contains a Social Security number or other sensitive ID. Please remove it.`);
    }
  }
  await requireSandbox(body.sandboxId);
  const store = new SupabaseStore(body.sandboxId);
  if ((await store.listApplicants()).length >= MAX_APPLICANTS) {
    throw new HttpError(409, `A sandbox can hold at most ${MAX_APPLICANTS} applicants. Use Start over to begin again.`);
  }
  const applicant = await store.addApplicant({ name: body.name, role: body.role, notes: body.notes });
  await store.addAudit(applicant.id, 'added', `${applicant.name}, ${applicant.role}`);
  return json({ applicant, state: await getState(body.sandboxId) });
});
