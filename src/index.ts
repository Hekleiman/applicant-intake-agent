import { createInterface } from 'node:readline';
import { MemorySession, run } from '@openai/agents';
import { intakeAgent } from './agents/intake.js';

const interactive = process.stdin.isTTY === true;
const session = new MemorySession();
const rl = createInterface({ input: process.stdin, terminal: false });

const prompt = () => {
  if (interactive) process.stdout.write('You: ');
};

prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '') {
    prompt();
    continue;
  }
  if (line.toLowerCase() === 'exit') break;

  try {
    const result = await run(intakeAgent, line, { session, maxTurns: 6 });

    for (const item of result.newItems) {
      console.log(`[item] ${item.type}`);
    }
    console.log(`Agent: ${result.finalOutput}`);

    const usage = result.state.usage;
    console.log(
      `[usage] requests=${usage.requests} input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens}`,
    );
  } catch (error) {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  }
  prompt();
}

rl.close();
