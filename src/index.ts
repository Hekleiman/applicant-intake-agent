import { createInterface } from 'node:readline';
import { MemorySession, run } from '@openai/agents';
import { startingAgent } from './agents/index.js';

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
    // Triage routing: every message starts at Intake, which hands scheduling off one way
    // to the Scheduler. Measured against sticky routing (start at the last agent), triage
    // passed 21/21 checks vs 20/21, at ~21% more input tokens.
    const result = await run(startingAgent, line, { session, maxTurns: 6 });

    for (const item of result.newItems) {
      console.log(`[item] ${item.type}`);
    }
    const lastAgent = result.lastAgent ?? startingAgent;

    const reply = typeof result.finalOutput === 'string' ? result.finalOutput : '';
    if (reply.trim() === '') {
      console.log(`[warn] empty reply from ${lastAgent.name}`);
    } else {
      console.log(`Agent: ${reply}`);
    }

    console.log(`[agent] ${lastAgent.name}`);

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
