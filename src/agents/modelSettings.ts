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
