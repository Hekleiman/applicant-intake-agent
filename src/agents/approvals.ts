// Wording for the tool calls that pause for a human: reject_applicant, and advance_stage when
// the target is an offer. Shared by the CLI and the live API.

export type ApprovalAction = 'rejection' | 'offer';

export function approvalAction(toolName: string | undefined, args: unknown): ApprovalAction {
  const stage = args && typeof args === 'object' ? (args as { stage?: unknown }).stage : undefined;
  return toolName === 'advance_stage' && stage === 'offer' ? 'offer' : 'rejection';
}

export function declineMessage(action: ApprovalAction): string {
  const unchanged = action === 'offer' ? 'the stage is unchanged' : 'the status is unchanged';
  return `A human recruiter declined this ${action}. Do not retry. Tell the user it was declined and ${unchanged}.`;
}

export function parseArgs(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    return raw ?? '';
  }
}

export function applicantIdOf(args: unknown): string {
  const id = args && typeof args === 'object' ? (args as { applicantId?: unknown }).applicantId : undefined;
  return typeof id === 'string' && id.trim() ? id.trim() : 'unknown';
}
