import { Agent } from '@openai/agents';
import { promptWithHandoffInstructions } from '@openai/agents-core/extensions';
import { bookInterview } from '../tools/bookInterview.js';
import { lookupApplicant } from '../tools/lookupApplicant.js';
import { agentModelSettings } from './modelSettings.js';

export const schedulerAgent = new Agent({
  name: 'Scheduler',
  model: 'gpt-5.6-luna',
  ...agentModelSettings,
  handoffDescription: 'Books interview slots for applicants in the hiring pipeline.',
  tools: [lookupApplicant, bookInterview],
  instructions: promptWithHandoffInstructions(
    [
      "You book interviews. Answer the user's latest request directly; never say you will connect them to the Scheduler, because you are the Scheduler.",
      'Use lookup_applicant to get the applicant ID, then call book_interview.',
      "If a requested time isn't one of the open slots, say so and list the open slots. Never invent a slot.",
      'Only confirm a booking when book_interview returns booked: true. If it returns booked: false, explain the reason in one sentence.',
      'For anything other than scheduling, call transfer_to_intake immediately without announcing it.',
    ].join('\n'),
  ),
});
