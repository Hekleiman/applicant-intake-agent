import { mkdirSync, writeFileSync } from 'node:fs';
import type { Runner } from '@openai/agents';
import { attachToolEvents, EventCollector, type RunEvent } from './runEvents.js';

// Records a CLI run's events for the replay page. RECORD=<scenario> turns it on; the events are
// kept in memory and written to docs/data/<scenario>.json when the process exits. Unset, it's a
// no-op. CLI only: the live API collects its events per request with its own EventCollector.

const scenario = process.env.RECORD?.trim() || undefined;
const collector = new EventCollector();

// Same shape the guardrail blocks on, without word boundaries: the strictest form.
const SSN_LIKE = /\d{3}[- ]?\d{2}[- ]?\d{4}/g;

export const record: EventCollector['emit'] = (type, data, at) => {
  if (scenario) collector.emit(type, data, at);
};

// A blocked message was already recorded when it was read; mask its digits so the file never
// holds an SSN-shaped value.
export function redactLastUserMessage(): void {
  const events = collector.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'user_message') continue;
    event.data.text = event.data.text.replace(/\d/g, '#');
    return;
  }
}

export function attachRecorder(runner: Runner): void {
  if (scenario) attachToolEvents(runner, record);
}

// Last line of defence: any SSN-shaped string that slipped through is masked. Trace IDs are
// random hex and can contain nine digits in a row; they are kept as they are.
function maskEvent(event: RunEvent): RunEvent {
  if (event.type === 'trace') return event;
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(SSN_LIKE, (m) => m.replace(/\d/g, '#'));
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
    }
    return value;
  };
  return mask(event) as RunEvent;
}

if (scenario) {
  const startedAt = Date.now();
  process.on('exit', () => {
    const file = {
      scenario,
      recordedAt: new Date(startedAt).toISOString(),
      events: collector.events.map(maskEvent),
    };
    const dir = new URL('../../docs/data/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${scenario}.json`, dir), `${JSON.stringify(file, null, 2)}\n`);
  });
}
