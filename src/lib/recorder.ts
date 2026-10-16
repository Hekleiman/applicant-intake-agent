import { mkdirSync, writeFileSync } from 'node:fs';
import type { Runner } from '@openai/agents';

// Records a run's events for the replay page. RECORD=<scenario> turns it on; the events are kept
// in memory and written to docs/data/<scenario>.json when the process exits. Unset, it's a no-op.
// Tool calls and handoffs come from the Runner's lifecycle hooks (attachRecorder), so tools,
// guardrails and agents don't know the recorder exists.

type EventData = {
  user_message: { text: string };
  guardrail: { result: 'pass' | 'blocked'; reason?: string };
  tool_call: { agent: string; tool: string; args: unknown; output: unknown; durationMs: number };
  handoff: { from: string; to: string };
  approval_requested: { agent: string; tool: string; args: unknown };
  approval_decision: { decision: 'approved' | 'declined' };
  agent_reply: { agent: string; text: string };
  turn_usage: { requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
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

// `at` (a Date.now() value) places an event that is only known after the fact, like a guardrail
// result read from the finished run, at the moment it actually happened.
export function record<K extends EventType>(type: K, data: EventData[K], at = Date.now()): void {
  if (!scenario) return;
  const event = { type, timestamp: at - startedAt, data } as RecordedEvent;
  let i = events.length;
  while (i > 0 && (events[i - 1]?.timestamp ?? 0) > event.timestamp) i--;
  events.splice(i, 0, event);
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

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export function attachRecorder(runner: Runner): void {
  if (!scenario) return;
  const toolStarts = new Map<string, number>();

  runner.on('agent_tool_start', (_context, _agent, _tool, { toolCall }) => {
    if (toolCall.type === 'function_call') toolStarts.set(toolCall.callId, Date.now());
  });

  runner.on('agent_tool_end', (_context, agent, tool, result, { toolCall }) => {
    if (toolCall.type !== 'function_call') return;
    const started = toolStarts.get(toolCall.callId) ?? Date.now();
    toolStarts.delete(toolCall.callId);
    record('tool_call', {
      agent: agent.name,
      tool: tool.name,
      args: parseJson(toolCall.arguments),
      // The SDK hands over the string sent back to the model, so this is a snapshot: a later
      // booking or rejection can't change what this call appears to have returned.
      output: parseJson(result),
      durationMs: Date.now() - started,
    });
  });

  runner.on('agent_handoff', (_context, fromAgent, toAgent) => {
    record('handoff', { from: fromAgent.name, to: toAgent.name });
  });
}

// Last line of defence: any SSN-shaped string that slipped through is masked. Trace IDs are
// random hex and can contain nine digits in a row; they are kept as they are.
function maskEvent(event: RecordedEvent): RecordedEvent {
  if (event.type === 'trace') return event;
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(SSN_LIKE, (m) => m.replace(/\d/g, '#'));
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
    }
    return value;
  };
  return mask(event) as RecordedEvent;
}

if (scenario) {
  process.on('exit', () => {
    const file = {
      scenario,
      recordedAt: new Date(startedAt).toISOString(),
      events: events.map(maskEvent),
    };
    const dir = new URL('../../docs/data/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${scenario}.json`, dir), `${JSON.stringify(file, null, 2)}\n`);
  });
}
