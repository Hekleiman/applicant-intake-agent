import { tool } from '@openai/agents';
import { z } from 'zod';
import { GENERAL_REQUIREMENTS, OPEN_ROLES, requirementsFor, type RoleRequirements } from '../data/roles.js';

// A criterion that needs a human check ends with "(a human must verify ...)" in src/data/roles.ts.
// The tool returns that note as its own verifyNote field so the assistant can't drop it as an aside.
const VERIFY_SUFFIX = /\s*\((a human must verify[^)]*)\)\s*$/i;

type Criterion = { criterion: string; verifyNote?: string };

function split(text: string): Criterion {
  const m = VERIFY_SUFFIX.exec(text);
  if (!m) return { criterion: text };
  const note = m[1]!;
  return { criterion: text.slice(0, m.index), verifyNote: `${note.charAt(0).toUpperCase()}${note.slice(1)}.` };
}

function withNotes(r: RoleRequirements): { mustHave: Criterion[]; niceToHave: Criterion[] } {
  return { mustHave: r.mustHave.map(split), niceToHave: r.niceToHave.map(split) };
}

// Read-only: returns the same criteria the Screener uses, from src/data/roles.ts, so the
// assistant never describes requirements from memory.
export const getRoleRequirements = tool({
  name: 'get_role_requirements',
  description:
    'Get the screening criteria for a role: must-haves and nice-to-haves, from the same list the resume screener uses. Each criterion may carry a verifyNote saying what a human must check; include every verifyNote in your answer. Also lists every open role. Use "all" to get every open role with its criteria. A role that is not listed returns the general criteria with general: true.',
  parameters: z.object({
    role: z.string().describe('A role name such as Caregiver, or "all" for every open role.'),
  }),
  execute: async ({ role }) => {
    const openRoles = OPEN_ROLES.map((r) => r.name);
    let result;
    if (role.trim().toLowerCase() === 'all') {
      result = {
        openRoles: OPEN_ROLES.map((r) => ({ name: r.name, ...withNotes(r) })),
        otherRoles: 'Any other role is screened against the general criteria.',
        generalCriteria: withNotes(GENERAL_REQUIREMENTS),
      };
    } else {
      const match = requirementsFor(role);
      result = { role: match.role, general: match.general, ...withNotes(match.requirements), openRoles };
    }
    console.log(`[tool] get_role_requirements("${role}") -> ${'general' in result ? (result.general ? 'general criteria' : result.role) : 'all roles'}`);
    return result;
  },
});
