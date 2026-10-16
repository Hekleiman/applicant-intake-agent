import { tool } from '@openai/agents';
import { z } from 'zod';
import { openSlots } from '../data/slots.js';

export const listOpenSlots = tool({
  name: 'list_open_slots',
  description:
    'Returns the interview slots that are still open right now. Call it before telling the user which slots are available.',
  parameters: z.object({}),
  execute: async () => {
    const slots = openSlots();
    console.log(`[tool] list_open_slots -> ${JSON.stringify(slots)}`);
    return { openSlots: slots };
  },
});
