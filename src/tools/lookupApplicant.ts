import { tool } from '@openai/agents';
import { z } from 'zod';
import { applicants } from '../data/applicants.js';

export const lookupApplicant = tool({
  name: 'lookup_applicant',
  description:
    'Look up an applicant in the hiring pipeline. Use this whenever the user asks about a specific applicant.',
  parameters: z.object({
    query: z
      .string()
      .describe('An applicant ID like A-1001, or a full or partial applicant name.'),
  }),
  execute: async ({ query }) => {
    const q = query.trim().toLowerCase();
    const matches = applicants.filter(
      (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
    );
    console.log(`[tool] lookup_applicant("${query}") -> ${matches.length} match(es)`);

    const [only] = matches;
    const result =
      matches.length === 1 && only
        ? { found: true, applicant: only }
        : matches.length > 1
          ? { found: false, ambiguous: matches.map((a) => a.name) }
          : { found: false };
    return result;
  },
});
