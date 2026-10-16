import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SLOTS } from '../data/slots.js';
import { storeFor } from '../data/storeFor.js';

export const bookInterview = tool({
  name: 'book_interview',
  description: 'Book an interview for one applicant in one open slot.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
    slot: z.enum(SLOTS).describe('One of the open interview slots.'),
  }),
  execute: async ({ applicantId, slot }, runContext?: RunContext<AppContext>) => {
    const store = storeFor(runContext);
    const applicant = await store.getApplicant(applicantId);

    let result;
    if (!applicant) {
      result = { booked: false, reason: 'unknown applicant' };
    } else if (applicant.stage === 'rejected') {
      result = { booked: false, reason: 'applicant rejected' };
    } else {
      // "Already booked" and "slot taken" are decided by the store; in a live sandbox that is
      // the database's unique constraints, so two racing bookings can't both succeed.
      const booking = await store.bookSlot(applicant.id, slot);
      if (booking.ok) {
        await store.setStage(applicant.id, 'interview_scheduled');
        await store.addAudit(applicant.id, 'booked', slot);
        result = { booked: true, applicantId: applicant.id, name: applicant.name, slot };
      } else if (booking.reason === 'already booked') {
        result = { booked: false, reason: 'already booked', currentSlot: booking.currentSlot };
      } else {
        result = { booked: false, reason: 'slot taken', openSlots: await store.openSlots() };
      }
    }

    console.log(`[tool] book_interview(${applicantId}, ${slot}) -> ${JSON.stringify(result)}`);
    return result;
  },
});
