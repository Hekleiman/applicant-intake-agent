import { mkdirSync, writeFileSync } from 'node:fs';

// Records a run's events for the replay page. RECORD=<scenario> turns it on; the events are kept
// in memory and written to docs/data/<scenario>.json when the process exits. Unset, it's a no-op.

type EventData = {
  user_message: { text: string };
  guardrail: { result: 'pass' | 'blocked'; reason?: string };
  tool_call: { agent: string; tool: string; args: unknown; output: unknown; durationMs: number };
  handoff: { from: string; to: string };
  approval_requested: { agent: string; tool: string; args: unknown };
  approval_decision: { decision: 'approved' | 'declined' };
  agent_reply: { agent: string; text: string };
  turn_usage: { requests: number; inputTokens: number; outputTokens: number };
  trace: { traceId: string };
};

type EventType = keyof EventData;
type RecordedEvent = {
  [K in EventType]: { type: K; timestamp: number; data: EventData[K] };
}[EventType];

const scenario = process.env.RECORD?.trim() || undefined;
const startedAt = Date.now();
const events: RecordedEvent[] = [];

// Same shape the guardrail blocks on, without word boundaries: the strictest form.
const SSN_LIKE = /\d{3}[- ]?\d{2}[- ]?\d{4}/g;

export const recording = scenario !== undefined;

export function record<K extends EventType>(type: K, data: EventData[K]): void {
  if (!scenario) return;
  events.push({ type, timestamp: Date.now() - startedAt, data } as RecordedEvent);
}

// A blocked message was already recorded when it was read; mask its digits so the file never
// holds an SSN-shaped value.
export function redactLastUserMessage(): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'user_message') continue;
    event.data.text = event.data.text.replace(/\d/g, '#');
    return;
  }
}

// The agent whose turn is running, set from agent_start hooks so shared tools know who called them.
let currentAgent = 'unknown';
export const setCurrentAgent = (name: string) => {
  currentAgent = name;
};

// Copies args and output: tools return live data objects, and a later booking or rejection would
// otherwise change what this earlier call appears to have returned.
export function recordToolCall(tool: string, args: unknown, output: unknown, started: number): void {
  if (!scenario) return;
  const durationMs = Date.now() - started;
  record('tool_call', {
    agent: currentAgent,
    tool,
    args: structuredClone(args),
    output: structuredClone(output),
    durationMs,
  });
}

if (scenario) {
  process.on('exit', () => {
    const file = { scenario, recordedAt: new Date(startedAt).toISOString(), events };
    const json = JSON.stringify(file, null, 2)
      // Random hex trace IDs can contain 9 digits in a row. Write their digits as JSON \u escapes:
      // the parsed value is unchanged, but the file never shows an SSN-shaped run of digits.
      .replace(/"traceId": "([^"]*)"/g, (_, id: string) =>
        `"traceId": "${id.replace(/\d/g, (d) => `\\u00${d.charCodeAt(0).toString(16)}`)}"`,
      )
      // Last line of defence: anything else SSN-shaped that slipped through is masked.
      .replace(SSN_LIKE, (match) => match.replace(/\d/g, '#'));
    const dir = new URL('../../docs/data/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${scenario}.json`, dir), `${json}\n`);
  });
}
