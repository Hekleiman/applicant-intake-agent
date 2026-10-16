import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { storeFor } from '../data/storeFor.js';

export const listOpenSlots = tool({
  name: 'list_open_slots',
  description:
    'Returns the interview slots that are still open right now for one applicant. Call it before telling the user which slots are available.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001, from lookup_applicant.'),
  }),
  execute: async ({ applicantId }, runContext?: RunContext<AppContext>) => {
    const store = storeFor(runContext);
    const applicant = await store.getApplicant(applicantId);

    // Same rule as book_interview: no times are offered for someone who can't be booked.
    let result;
    if (!applicant) {
      result = { error: 'unknown applicant' };
    } else if (applicant.stage === 'rejected') {
      result = {
        error: 'applicant rejected',
        message: `${applicant.name} was rejected and can't be scheduled.`,
      };
    } else {
      result = { openSlots: await store.openSlots() };
    }

    console.log(`[tool] list_open_slots(${applicantId}) -> ${JSON.stringify(result)}`);
    return result;
  },
});
