import { Agent } from '@openai/agents';
import { promptWithHandoffInstructions } from '@openai/agents-core/extensions';
import type { AppContext } from '../context.js';
import { bookInterview } from '../tools/bookInterview.js';
import { listOpenSlots } from '../tools/listOpenSlots.js';
import { lookupApplicant } from '../tools/lookupApplicant.js';
import { agentModelSettings } from './modelSettings.js';

export const schedulerAgent = new Agent<AppContext>({
  name: 'Scheduler',
  model: 'gpt-5.6-luna',
  ...agentModelSettings,
  handoffDescription: 'Books interview slots for applicants in the hiring pipeline.',
  tools: [lookupApplicant, bookInterview, listOpenSlots],
  instructions: promptWithHandoffInstructions(
    [
      "You book interviews. Answer the user's latest request directly; never say you will connect them to the Scheduler, because you are the Scheduler.",
      'Use lookup_applicant to get the applicant ID, then call book_interview.',
      "If a requested time isn't available, look up the applicant first, then call list_open_slots with their ID and offer only the slots it returns. If it returns an error, explain it in one sentence and offer no times. Never list slots from memory or from a tool's parameter options.",
      'Only confirm a booking when book_interview returns booked: true. If it returns booked: false, explain the reason in one sentence.',
      "If asked about an applicant's details or stage, answer using lookup_applicant. Politely decline requests unrelated to recruiting.",
    ].join('\n'),
  ),
});
