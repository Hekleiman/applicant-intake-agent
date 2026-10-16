import { createInterface } from 'node:readline';
import { MemorySession, run } from '@openai/agents';
import { startingAgent } from './agents/index.js';

const interactive = process.stdin.isTTY === true;
const session = new MemorySession();
let currentAgent = startingAgent;
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
    const result = await run(currentAgent, line, { session, maxTurns: 6 });

    for (const item of result.newItems) {
      console.log(`[item] ${item.type}`);
    }
    currentAgent = result.lastAgent ?? currentAgent;

    const reply = typeof result.finalOutput === 'string' ? result.finalOutput : '';
    if (reply.trim() === '') {
      console.log(`[warn] empty reply from ${currentAgent.name}`);
    } else {
      console.log(`Agent: ${reply}`);
    }

    console.log(`[agent] ${currentAgent.name}`);

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
