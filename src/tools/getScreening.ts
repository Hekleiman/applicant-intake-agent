import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { storeFor } from '../data/storeFor.js';

// The chat agents see only the Screener's structured result, never the resume text, so
// instructions hidden in a resume can't reach an agent that has tools.
export const getScreening = tool({
  name: 'get_screening',
  description:
    "Get the AI resume screening for one applicant: fit, summary, requirement statuses, concerns and what to verify. Advisory only; it is not a decision and has verified nothing. Only call it with an ID returned by lookup_applicant.",
  parameters: z.object({
    applicantId: z.string().describe('An applicant ID like A-1001.'),
  }),
  execute: async ({ applicantId }, runContext?: RunContext<AppContext>) => {
    const record = await storeFor(runContext).getScreening(applicantId);

    let result;
    if (!record) {
      result = { found: false, reason: 'unknown applicant' };
    } else if (!record.hasResume) {
      result = { found: false, reason: 'no resume uploaded' };
    } else if (!record.screening) {
      result = { found: false, reason: record.screenedAt ? 'screening did not finish' : 'screening still running' };
    } else {
      const s = record.screening;
      result = {
        found: true,
        advisoryOnly: 'An AI summary to help a recruiter. It is not a decision and has not verified anything.',
        role: s.role,
        generalCriteria: s.generalCriteria,
        fit: s.fit,
        summary: s.summary,
        requirements: s.requirements.map((r) => ({ requirement: r.requirement, status: r.status })),
        // Issues only: the evidence fields quote the resume, and resume text stays out of chat.
        concerns: s.concerns.map((c) => c.issue),
        toVerify: s.toVerify,
        injectionAttempt: s.injectionAttempt,
      };
    }

    console.log(`[tool] get_screening(${applicantId}) -> ${result.found ? `fit=${'fit' in result ? result.fit : ''}` : result.reason}`);
    return result;
  },
});
