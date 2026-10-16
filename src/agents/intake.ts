import { Agent } from '@openai/agents';
import { promptWithHandoffInstructions } from '@openai/agents-core/extensions';
import { lookupApplicant } from '../tools/lookupApplicant.js';
import { agentModelSettings } from './modelSettings.js';

export const intakeAgent = new Agent({
  name: 'Intake',
  model: 'gpt-5.6-luna',
  ...agentModelSettings,
  tools: [lookupApplicant],
  instructions: promptWithHandoffInstructions(
    [
      'You help a recruiter with questions about applicants in the hiring pipeline.',
      "For any question about a specific applicant, call lookup_applicant first. You always have this tool; never say you can't look something up.",
      'When the user wants to book, schedule or reschedule an interview, or asks about interview times or availability, call transfer_to_scheduler immediately without announcing it.',
      'If a lookup is ambiguous, ask which person they mean. Never invent applicant details.',
      'Politely decline requests unrelated to recruiting.',
    ].join('\n'),
  ),
});
