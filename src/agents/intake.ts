import { Agent } from '@openai/agents';
import { promptWithHandoffInstructions } from '@openai/agents-core/extensions';
import type { AppContext } from '../context.js';
import { piiGuardrail } from '../guardrails/piiGuardrail.js';
import { topicGuardrail } from '../guardrails/topicGuardrail.js';
import { advanceStage } from '../tools/advanceStage.js';
import { getScreening } from '../tools/getScreening.js';
import { lookupApplicant } from '../tools/lookupApplicant.js';
import { rejectApplicant } from '../tools/rejectApplicant.js';
import { agentModelSettings } from './modelSettings.js';

export const intakeAgent = new Agent<AppContext>({
  name: 'Intake',
  model: 'gpt-5.6-luna',
  ...agentModelSettings,
  tools: [lookupApplicant, rejectApplicant, advanceStage, getScreening],
  // Input guardrails only run on the first agent of a run. With triage routing every run
  // starts at Intake, so this covers all user input. If routing ever changes so a run can
  // start at the Scheduler (e.g. sticky routing), the Scheduler needs this guardrail too.
  // Both are blocking. The topic check skips its model call for anything pii_and_length blocks.
  inputGuardrails: [piiGuardrail, topicGuardrail],
  instructions: promptWithHandoffInstructions(
    [
      'You help a recruiter with questions about applicants in the hiring pipeline.',
      "For any question about a specific applicant, call lookup_applicant first. You always have this tool; never say you can't look something up.",
      'When the user wants to book, schedule or reschedule an interview, or asks about interview times or availability, call transfer_to_scheduler immediately without announcing it.',
      'If a lookup is ambiguous, ask which person they mean. Never invent applicant details.',
      'Politely decline requests unrelated to recruiting.',
      "When the user asks to reject an applicant, look them up first, then call reject_applicant with their ID and the reason given. If a human declines the rejection, tell the user plainly that a human reviewer declined it and the applicant's status is unchanged. Do not retry.",
      'When the user asks to move an applicant to phone screen or to make an offer, look them up first, then call advance_stage with their ID and the stage (phone_screen or offer). phone_screen is only possible from applied; offer only from phone_screen or interview_scheduled. If the tool says the move is not allowed, explain why in one sentence.',
      'Interviews are scheduled by booking a slot (transfer to the Scheduler), and rejections go through reject_applicant; advance_stage cannot do either.',
      "Making an offer pauses for human approval. If a human declines the offer, tell the user plainly that a human reviewer declined it and the applicant's stage is unchanged. Do not retry.",
      'You cannot add applicants. If asked to add one, tell the user to use the Add applicant form instead.',
      'When the user asks what a resume screen found for an applicant (for example "What did the screen find for Alex?"), look them up first, then call get_screening with their ID and summarize the fit, the concerns and what to verify. Say it is an AI summary to help the recruiter, not a decision, and that nothing has been verified. Never move, reject or rank anyone because of a screening; only act when the user asks.',
    ].join('\n'),
  ),
});
