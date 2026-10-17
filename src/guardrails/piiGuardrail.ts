import type { InputGuardrail, InputGuardrailFunctionArgs } from '@openai/agents';

const SSN_LIKE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
const MAX_LENGTH = 2000;

type Input = InputGuardrailFunctionArgs['input'];

export type PolicyViolation = 'ssn_like' | 'too_long';

// The code-only rules, shared with the topic check so it can skip messages blocked here, and with
// the Add applicant form. A resume passes its own, larger maxLength.
export function findPolicyViolation(text: string, maxLength = MAX_LENGTH): PolicyViolation | null {
  return SSN_LIKE.test(text) ? 'ssn_like' : text.length > maxLength ? 'too_long' : null;
}

// Text of the newest user message, whether the run got a plain string or a list of items.
export function newestUserText(input: Input): string {
  if (typeof input === 'string') return input;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || !('role' in item) || item.role !== 'user') continue;
    if (typeof item.content === 'string') return item.content;
    return item.content
      .map((part) => (part.type === 'input_text' ? part.text : ''))
      .join('');
  }
  return '';
}

// Code-only check: no model call, so it costs nothing and can't be talked out of a decision.
export const piiGuardrail: InputGuardrail = {
  name: 'pii_and_length',
  // Blocking on purpose. Measured with runInParallel: true: blocked turns still made 0 model
  // requests, because the SDK checks for a finished tripwire after preparing the model call
  // and before sending it, and this code-only check always finishes first. Session counts were
  // identical too. That's timing luck, not a guarantee: a slower check (e.g. one that calls a
  // model) would let the request go out and cost tokens. Blocking makes 0 requests by design.
  runInParallel: false,
  execute: async ({ input }) => {
    const text = newestUserText(input);
    const reason = findPolicyViolation(text);
    const shape = typeof input === 'string' ? '"string"' : `"array of ${input.length} items"`;
    console.log(
      `[guardrail] input=${shape} newest_len=${text.length} -> ${reason ? `blocked: ${reason}` : 'pass'}`,
    );
    return { tripwireTriggered: reason !== null, outputInfo: { reason } };
  },
};
