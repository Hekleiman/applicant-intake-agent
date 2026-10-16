import { handoff } from '@openai/agents';
import { intakeAgent } from './intake.js';
import { schedulerAgent } from './scheduler.js';

// Wired here so the agent files don't import each other.
intakeAgent.handoffs = [
  handoff(schedulerAgent, {
    onHandoff: () => {
      console.log('[handoff] Intake -> Scheduler');
    },
  }),
];

export const startingAgent = intakeAgent;
