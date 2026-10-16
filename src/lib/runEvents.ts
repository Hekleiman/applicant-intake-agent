import type { Runner } from '@openai/agents';

// The lifecycle events a run produces, shared by the CLI recorder (replay page) and the live
// API (technical details under each reply).

export type Usage = { requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };

export type EventData = {
  user_message: { text: string };
  guardrail: {
    name: string;
    result: 'pass' | 'blocked' | 'skipped';
    reason?: string;
    classifierReason?: string;
    usage?: Usage;
  };
  tool_call: { agent: string; tool: string; args: unknown; output: unknown; durationMs: number };
  handoff: { from: string; to: string };
  approval_requested: { agent: string; tool: string; args: unknown };
  approval_decision: { decision: 'approved' | 'declined'; tool?: string };
  agent_reply: { agent: string; text: string };
  // Totals for the turn, topic check included; topicCheck is its share.
  turn_usage: Usage & { topicCheck: Usage };
  trace: { traceId: string };
};

export type EventType = keyof EventData;
export type RunEvent = {
  [K in EventType]: { type: K; timestamp: number; data: EventData[K] };
}[EventType];

export type Emit = <K extends EventType>(type: K, data: EventData[K], at?: number) => void;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// Tool calls and handoffs come from the Runner's lifecycle hooks, so tools, guardrails and agents
// don't know anything is listening. Attach to a Runner that serves one request (live) or one
// process (CLI); the start times are kept per Runner.
export function attachToolEvents(runner: Runner, emit: Emit): void {
  const toolStarts = new Map<string, number>();

  runner.on('agent_tool_start', (_context, _agent, _tool, { toolCall }) => {
    if (toolCall.type === 'function_call') toolStarts.set(toolCall.callId, Date.now());
  });

  runner.on('agent_tool_end', (_context, agent, tool, result, { toolCall }) => {
    if (toolCall.type !== 'function_call') return;
    const started = toolStarts.get(toolCall.callId) ?? Date.now();
    toolStarts.delete(toolCall.callId);
    emit('tool_call', {
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
    emit('handoff', { from: fromAgent.name, to: toAgent.name });
  });
}

// An ordered event list for one request. `at` (a Date.now() value) places an event that is only
// known after the fact, like a guardrail result read from the finished run, where it happened.
export class EventCollector {
  readonly events: RunEvent[] = [];
  private readonly startedAt = Date.now();

  emit: Emit = (type, data, at = Date.now()) => {
    const event = { type, timestamp: at - this.startedAt, data } as RunEvent;
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1]?.timestamp ?? 0) > event.timestamp) i--;
    this.events.splice(i, 0, event);
  };
}
