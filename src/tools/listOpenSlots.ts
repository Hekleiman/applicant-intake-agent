import { tool } from '@openai/agents';
import { z } from 'zod';
import { applicants } from '../data/applicants.js';
import { openSlots } from '../data/slots.js';

export const listOpenSlots = tool({
  name: 'list_open_slots',
  description:
    'Returns the interview slots that are still open right now for one applicant. Call it before telling the user which slots are available.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001, from lookup_applicant.'),
  }),
  execute: async ({ applicantId }) => {
    const applicant = applicants.find((a) => a.id === applicantId.trim());

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
      result = { openSlots: openSlots() };
    }

    console.log(`[tool] list_open_slots(${applicantId}) -> ${JSON.stringify(result)}`);
    return result;
  },
});
