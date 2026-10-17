import { tool } from '@openai/agents';
import { z } from 'zod';
import { GENERAL_REQUIREMENTS, OPEN_ROLES, requirementsFor } from '../data/roles.js';

// Read-only: returns the same criteria the Screener uses, from src/data/roles.ts, so the
// assistant never describes requirements from memory.
export const getRoleRequirements = tool({
  name: 'get_role_requirements',
  description:
    'Get the screening criteria for a role: must-haves and nice-to-haves, from the same list the resume screener uses. Also lists every open role. Use "all" to get every open role with its criteria. A role that is not listed returns the general criteria with general: true.',
  parameters: z.object({
    role: z.string().describe('A role name such as Caregiver, or "all" for every open role.'),
  }),
  execute: async ({ role }) => {
    const openRoles = OPEN_ROLES.map((r) => r.name);
    let result;
    if (role.trim().toLowerCase() === 'all') {
      result = { openRoles: OPEN_ROLES, otherRoles: 'Any other role is screened against the general criteria.', generalCriteria: GENERAL_REQUIREMENTS };
    } else {
      const match = requirementsFor(role);
      result = { role: match.role, general: match.general, ...match.requirements, openRoles };
    }
    console.log(`[tool] get_role_requirements("${role}") -> ${'general' in result ? (result.general ? 'general criteria' : result.role) : 'all roles'}`);
    return result;
  },
});
