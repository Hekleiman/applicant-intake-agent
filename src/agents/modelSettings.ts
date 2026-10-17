import type { ModelSettings } from '@openai/agents';

type Effort = NonNullable<NonNullable<ModelSettings['reasoning']>['effort']>;

// Every value allowed by the installed ModelSettings type; the Record keeps this in sync.
const EFFORTS: Record<Effort, true> = {
  none: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

const isEffort = (value: string): value is Effort => Object.hasOwn(EFFORTS, value);

// REASONING_EFFORT overrides the reasoning effort; when unset, no modelSettings
// are passed so the SDK default applies.
const raw = process.env.REASONING_EFFORT?.trim();
if (raw && !isEffort(raw)) {
  throw new Error(
    `Invalid REASONING_EFFORT "${raw}". Expected one of: ${Object.keys(EFFORTS).join(', ')}`,
  );
}

export const agentModelSettings: { modelSettings?: ModelSettings } =
  raw && isEffort(raw) ? { modelSettings: { reasoning: { effort: raw } } } : {};

// Applied to every model call the live site makes (Intake, Scheduler, topic check, Screener)
// through each live Runner's modelSettings, which override the agents' own. store: false asks
// OpenAI not to keep the response for later retrieval; by default it does, and the trace
// dashboard opens those stored responses in full even when traceIncludeSensitiveData is false.
// Nothing here relies on stored responses: the full history is resent from the session on
// every turn and no previousResponseId or conversationId is used. The CLI keeps the default.
export const LIVE_MODEL_SETTINGS: ModelSettings = { store: false };
