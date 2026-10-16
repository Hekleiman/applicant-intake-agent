import type { InputGuardrailResult } from '@openai/agents';
import { topicGuardrail, type TopicOutputInfo } from '../guardrails/topicGuardrail.js';
import type { Emit } from './runEvents.js';

// Emits one guardrail event per input guardrail. The blocking guardrails run first thing in the
// run; their results are read afterwards and placed at `at`, the moment the run started.
export function emitGuardrails(emit: Emit, results: InputGuardrailResult[], at: number): void {
  for (const { guardrail, output } of results) {
    const name = guardrail.name;
    const reason = output.outputInfo?.reason;
    if (name !== topicGuardrail.name) {
      emit('guardrail', output.tripwireTriggered ? { name, result: 'blocked', reason } : { name, result: 'pass' }, at);
      continue;
    }
    const info = output.outputInfo as TopicOutputInfo;
    emit(
      'guardrail',
      !info.checked
        ? { name, result: 'skipped' }
        : {
            name,
            result: output.tripwireTriggered ? 'blocked' : 'pass',
            ...(reason ? { reason } : {}),
            classifierReason: info.classifierReason,
            usage: info.usage,
          },
      at,
    );
  }
}
