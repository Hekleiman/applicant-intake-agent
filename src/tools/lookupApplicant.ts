import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { storeFor } from '../data/storeFor.js';

export const lookupApplicant = tool({
  name: 'lookup_applicant',
  description:
    'Look up an applicant in the hiring pipeline. Use this whenever the user asks about a specific applicant.',
  parameters: z.object({
    query: z
      .string()
      .describe('An applicant ID like A-1001, or a full or partial applicant name.'),
  }),
  execute: async ({ query }, runContext?: RunContext<AppContext>) => {
    const matches = await storeFor(runContext).findApplicants(query);
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
