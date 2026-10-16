import { tool } from '@openai/agents';
import { z } from 'zod';
import { applicants } from '../data/applicants.js';
import { SLOTS, bookings } from '../data/slots.js';

const openSlots = () => SLOTS.filter((s) => !bookings.has(s));

export const bookInterview = tool({
  name: 'book_interview',
  description: 'Book an interview for one applicant in one open slot.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
    slot: z.enum(SLOTS).describe('One of the open interview slots.'),
  }),
  execute: async ({ applicantId, slot }) => {
    const applicant = applicants.find((a) => a.id === applicantId.trim());

    let result;
    if (!applicant) {
      result = { booked: false, reason: 'unknown applicant' };
    } else if (bookings.has(slot)) {
      result = { booked: false, reason: 'slot taken', openSlots: openSlots() };
    } else {
      bookings.set(slot, applicant.id);
      applicant.stage = 'interview_scheduled';
      result = { booked: true, applicantId: applicant.id, name: applicant.name, slot };
    }

    console.log(`[tool] book_interview(${applicantId}, ${slot}) -> ${JSON.stringify(result)}`);
    return result;
  },
});
