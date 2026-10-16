import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { applicants } from '../data/applicants.js';
import { auditEntry, type AppContext } from '../context.js';
import { recordToolCall } from '../lib/recorder.js';

export const rejectApplicant = tool({
  name: 'reject_applicant',
  description:
    'Reject an applicant. Requires human approval. Only call it with an ID returned by lookup_applicant.',
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
    reason: z.string().describe('A short reason for the rejection.'),
  }),
  // Every call pauses the run until a human approves or rejects it.
  needsApproval: true,
  execute: async ({ applicantId, reason }, runContext?: RunContext<AppContext>) => {
    const started = Date.now();
    const applicant = applicants.find((a) => a.id === applicantId.trim());
    if (!applicant) {
      console.log(`[tool] reject_applicant(${applicantId}) -> unknown applicant`);
      const result = { rejected: false, reason: 'unknown applicant' };
      recordToolCall('reject_applicant', { applicantId, reason }, result, started);
      return result;
    }

    applicant.stage = 'rejected';
    runContext?.context.audit.push(auditEntry(applicant.id, 'executed', reason));
    console.log(`[tool] reject_applicant(${applicant.id}) -> rejected`);
    const result = { rejected: true, applicantId: applicant.id, name: applicant.name };
    recordToolCall('reject_applicant', { applicantId, reason }, result, started);
    return result;
  },
});
