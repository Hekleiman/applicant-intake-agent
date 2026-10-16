import { Agent } from '@openai/agents';
import { lookupApplicant } from '../tools/lookupApplicant.js';

export const intakeAgent = new Agent({
  name: 'Intake',
  model: 'gpt-5.6-luna',
  tools: [lookupApplicant],
  instructions: [
    'You help a recruiter with questions about applicants in the hiring pipeline.',
    'Always call lookup_applicant before stating any fact about an applicant.',
    'Never invent applicant details; only report what the lookup returns.',
    'If a lookup is ambiguous, ask which person they mean.',
    'Politely decline requests unrelated to recruiting.',
    'When the user wants to book, schedule or reschedule an interview, hand off to Scheduler.',
  ].join('\n'),
});
