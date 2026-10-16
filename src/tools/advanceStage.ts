import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Stage } from '../data/store.js';
import { storeFor } from '../data/storeFor.js';

// The only moves this tool makes. interview_scheduled is set only by book_interview and
// rejected only by reject_applicant, so neither is a target here.
const ALLOWED_FROM: Record<'phone_screen' | 'offer', Stage[]> = {
  phone_screen: ['applied'],
  offer: ['phone_screen', 'interview_scheduled'],
};

export const advanceStage = tool({
  name: 'advance_stage',
  description:
    'Move an applicant forward: to phone_screen (only from applied) or to offer (only from phone_screen or interview_scheduled). Making an offer requires human approval. Only call it with an ID returned by lookup_applicant.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
    stage: z.enum(['phone_screen', 'offer']).describe('The stage to move the applicant to.'),
  }),
  // Conditional approval: an offer pauses the run for a human, a phone screen does not.
  // The SDK evaluates this again after a paused state is restored.
  needsApproval: async (_runContext, { stage }) => stage === 'offer',
  execute: async ({ applicantId, stage }, runContext?: RunContext<AppContext>) => {
    const store = storeFor(runContext);
    const applicant = await store.getApplicant(applicantId);

    let result;
    if (!applicant) {
      result = { moved: false, reason: 'unknown applicant' };
    } else if (applicant.stage === 'rejected') {
      result = { moved: false, reason: 'applicant rejected', message: `${applicant.name} was rejected and can't be moved.` };
    } else if (applicant.stage === stage) {
      result = { moved: false, reason: 'already in that stage', stage };
    } else if (!ALLOWED_FROM[stage].includes(applicant.stage)) {
      result = {
        moved: false,
        reason: 'not allowed from current stage',
        currentStage: applicant.stage,
        allowedFrom: ALLOWED_FROM[stage],
      };
    } else if (!(await store.setStage(applicant.id, stage, ALLOWED_FROM[stage]))) {
      // Compare-and-set lost to a concurrent change.
      result = { moved: false, reason: 'stage changed meanwhile, look the applicant up again' };
    } else {
      await store.addAudit(applicant.id, 'stage_changed', `${applicant.stage} -> ${stage}`);
      result = { moved: true, applicantId: applicant.id, name: applicant.name, from: applicant.stage, to: stage };
    }

    console.log(`[tool] advance_stage(${applicantId}, ${stage}) -> ${JSON.stringify(result)}`);
    return result;
  },
});
