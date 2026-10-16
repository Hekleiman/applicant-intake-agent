import { Agent } from '@openai/agents';
import { promptWithHandoffInstructions } from '@openai/agents-core/extensions';
import type { AppContext } from '../context.js';
import { piiGuardrail } from '../guardrails/piiGuardrail.js';
import { lookupApplicant } from '../tools/lookupApplicant.js';
import { rejectApplicant } from '../tools/rejectApplicant.js';
import { agentModelSettings } from './modelSettings.js';

export const intakeAgent = new Agent<AppContext>({
  name: 'Intake',
  model: 'gpt-5.6-luna',
  ...agentModelSettings,
  tools: [lookupApplicant, rejectApplicant],
  // Input guardrails only run on the first agent of a run. With triage routing every run
  // starts at Intake, so this covers all user input. If routing ever changes so a run can
  // start at the Scheduler (e.g. sticky routing), the Scheduler needs this guardrail too.
  inputGuardrails: [piiGuardrail],
  instructions: promptWithHandoffInstructions(
    [
      'You help a recruiter with questions about applicants in the hiring pipeline.',
      "For any question about a specific applicant, call lookup_applicant first. You always have this tool; never say you can't look something up.",
      'When the user wants to book, schedule or reschedule an interview, or asks about interview times or availability, call transfer_to_scheduler immediately without announcing it.',
      'If a lookup is ambiguous, ask which person they mean. Never invent applicant details.',
      'Politely decline requests unrelated to recruiting.',
      "When the user asks to reject an applicant, look them up first, then call reject_applicant with their ID and the reason given. If a human declines the rejection, tell the user plainly that a human reviewer declined it and the applicant's status is unchanged. Do not retry.",
    ].join('\n'),
  ),
});
