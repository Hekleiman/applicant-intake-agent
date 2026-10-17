import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { storeFor } from '../data/storeFor.js';

export const rejectApplicant = tool({
  name: 'reject_applicant',
  description:
    'Reject an applicant. Requires human approval. Only call it with an ID returned by lookup_applicant.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
    reason: z.string().describe('A short reason for the rejection.'),
  }),
  // Every call pauses the run until a human approves or rejects it.
  needsApproval: true,
  execute: async ({ applicantId, reason }, runContext?: RunContext<AppContext>) => {
    const store = storeFor(runContext);
    const applicant = await store.getApplicant(applicantId);
    if (!applicant) {
      console.log(`[tool] reject_applicant(${applicantId}) -> unknown applicant`);
      return { rejected: false, reason: 'unknown applicant' };
    }

    await store.setStage(applicant.id, 'rejected');
    // A rejected applicant gives up any interview slot, so the board and the open slots agree.
    await store.cancelBooking(applicant.id);
    await store.addAudit(applicant.id, 'rejected', reason);
    console.log(`[tool] reject_applicant(${applicant.id}) -> rejected`);
    return { rejected: true, applicantId: applicant.id, name: applicant.name };
  },
});
