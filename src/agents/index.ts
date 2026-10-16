import { handoff } from '@openai/agents';
import { intakeAgent } from './intake.js';
import { schedulerAgent } from './scheduler.js';
import { record, setCurrentAgent } from '../lib/recorder.js';

// Wired here so the agent files don't import each other.
intakeAgent.handoffs = [
  handoff(schedulerAgent, {
    onHandoff: () => {
      console.log('[handoff] Intake -> Scheduler');
      record('handoff', { from: 'Intake', to: 'Scheduler' });
    },
  }),
];

// Tracks which agent is running so the recorder can attribute shared tools like lookup_applicant.
for (const agent of [intakeAgent, schedulerAgent]) {
  agent.on('agent_start', () => setCurrentAgent(agent.name));
}

export const startingAgent = intakeAgent;
