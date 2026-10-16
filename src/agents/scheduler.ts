import { Agent } from '@openai/agents';
import { bookInterview } from '../tools/bookInterview.js';
import { lookupApplicant } from '../tools/lookupApplicant.js';

export const schedulerAgent = new Agent({
  name: 'Scheduler',
  model: 'gpt-5.6-luna',
  handoffDescription: 'Books interview slots for applicants in the hiring pipeline.',
  tools: [lookupApplicant, bookInterview],
  instructions: [
    'You book interview slots for applicants in the hiring pipeline.',
    "Always call lookup_applicant to get the applicant's ID before booking.",
    'Only book slots that book_interview accepts; never claim a booking the tool did not confirm.',
    "If a requested time isn't available, say so and list the open slots.",
    'Confirm each booking in one sentence.',
    'If the user asks for anything other than scheduling, hand off to Intake.',
  ].join('\n'),
});
