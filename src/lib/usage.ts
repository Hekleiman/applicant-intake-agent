import type { InputGuardrailResult, Usage as SdkUsage } from '@openai/agents';
import { topicGuardrail, type TopicOutputInfo } from '../guardrails/topicGuardrail.js';
import type { Usage } from './runEvents.js';

export const emptyUsage = (): Usage => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

export const addUsage = (target: Usage, add: Usage) => {
  target.requests += add.requests;
  target.inputTokens += add.inputTokens;
  target.cachedInputTokens += add.cachedInputTokens;
  target.outputTokens += add.outputTokens;
};

// A run's own usage (result.state.usage). The topic check's nested run is not part of it.
export const fromSdkUsage = (u: SdkUsage): Usage => ({
  requests: u.requests,
  inputTokens: u.inputTokens,
  cachedInputTokens: u.inputTokensDetails.reduce((sum, d) => sum + (d.cached_tokens ?? 0), 0),
  outputTokens: u.outputTokens,
});

// The topic check's own model call, or undefined when it was skipped or didn't run.
export const topicUsageOf = (results: InputGuardrailResult[]): Usage | undefined => {
  const result = results.find((r) => r.guardrail.name === topicGuardrail.name);
  const info = result?.output.outputInfo as TopicOutputInfo | undefined;
  return info?.checked ? info.usage : undefined;
};
