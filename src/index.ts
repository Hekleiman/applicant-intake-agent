import { run } from '@openai/agents';
import { intakeAgent } from './agents/intake.js';

const question = process.argv[2] ?? 'Where is Maria Lopez in the hiring process?';

const result = await run(intakeAgent, question, { maxTurns: 6 });

for (const item of result.newItems) {
  console.log(`[item] ${item.type}`);
}
console.log(result.finalOutput);
