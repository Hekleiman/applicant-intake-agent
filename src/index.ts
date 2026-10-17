import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  type Agent,
  type RunResult,
  MemorySession,
  RunContext,
  RunState,
  Runner,
  getGlobalTraceProvider,
  withTrace,
  type InputGuardrailResult,
} from '@openai/agents';
import { attachRecorder, record, redactLastUserMessage } from './lib/recorder.js';
import { takeRequestCount } from './lib/requestCounter.js';
import { startingAgent } from './agents/index.js';
import { applicantIdOf, approvalAction, declineMessage, parseArgs } from './agents/approvals.js';
import type { AppContext } from './context.js';
import { memoryStore } from './data/memoryStore.js';
import type { TopicUsage } from './guardrails/topicGuardrail.js';
import { OFF_TOPIC_REPLY, POLICY_REPLY } from './agents/replies.js';
import { addUsage, emptyUsage, topicUsageOf } from './lib/usage.js';
import { emitGuardrails } from './lib/guardrailEvents.js';

const MAX_TURNS = 8;

// One group per chat session, so every turn's trace can be filtered together on the dashboard.
const groupId = `chat_${randomUUID()}`;

const interactive = process.stdin.isTTY === true;
const session = new MemorySession();
// Plain data only: RunState.toString() serializes it. The CLI works on the in-memory store.
const appContext: AppContext = { sandboxId: null };
// One Runner for every run, including resumes, so its lifecycle hooks see all tool calls.
const runner = new Runner();
attachRecorder(runner);
const rl = createInterface({ input: process.stdin, terminal: false });

// One iterator for all input, so approval answers come from the same stream as chat
// messages (piped test files work).
const lines = rl[Symbol.asyncIterator]();
const nextLine = async (): Promise<string | undefined> => {
  const next = await lines.next();
  return next.done ? undefined : next.value.trim();
};

const prompt = (text = 'You: ') => {
  if (interactive) process.stdout.write(text);
};

type Result = RunResult<AppContext, Agent<AppContext, any>>;

let turnRequests = 0;
// Summed over the initial run and every resume: a restored run's usage starts from zero.
let turnUsage = emptyUsage();
let topicUsage = emptyUsage();

const describeTopic = (u: TopicUsage) =>
  `topic_check requests=${u.requests} input=${u.inputTokens} output=${u.outputTokens}`;

// `topic` is the topic check that ran before this segment; it is counted in the [usage] line
// so the line matches the HTTP counter, which sees both calls.
const reportSegment = (label: string, result: Result, topic?: TopicUsage) => {
  for (const item of result.newItems) {
    console.log(`[item] ${item.type}`);
  }
  const usage = result.state.usage;
  const main = {
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.inputTokensDetails.reduce((sum, d) => sum + (d.cached_tokens ?? 0), 0),
    outputTokens: usage.outputTokens,
  };
  const total = emptyUsage();
  addUsage(total, main);
  if (topic) addUsage(total, topic);
  const breakdown = topic
    ? ` (main requests=${main.requests} input=${main.inputTokens} output=${main.outputTokens}; ${describeTopic(topic)})`
    : '';
  console.log(
    `[usage] ${label} requests=${total.requests} input=${total.inputTokens} output=${total.outputTokens} total=${total.inputTokens + total.outputTokens}${breakdown}`,
  );
  addUsage(turnUsage, total);
  if (topic) addUsage(topicUsage, topic);
  const requests = takeRequestCount();
  turnRequests += requests;
  console.log(`[http] ${label} model requests=${requests}`);
};

// Asks a human about each pending tool call, then serializes, restores and resumes the run.
// Loops until the run finishes without interruptions.
async function resolveApprovals(result: Result): Promise<{ result: Result; resumes: number }> {
  let resumes = 0;
  while (result.interruptions.length > 0) {
    for (const item of result.interruptions) {
      const args = item.arguments ?? '';
      console.log(
        `[approval] ${item.agent.name} wants to run ${item.name}(${args}). Approve? (y/n)`,
      );
      const parsedArgs = parseArgs(args);
      const action = approvalAction(item.name, parsedArgs);
      const applicantId = applicantIdOf(parsedArgs);
      if (action === 'rejection') {
        const reason = (parsedArgs as { reason?: unknown } | null)?.reason;
        await memoryStore.addAudit(applicantId, 'rejection_requested', typeof reason === 'string' ? reason : '');
      } else {
        await memoryStore.addAudit(applicantId, 'offer_requested', 'offer');
      }
      record('approval_requested', {
        agent: item.agent.name,
        tool: item.name ?? 'unknown',
        args: parsedArgs,
      });
      prompt('Approve? ');
      const answer = (await nextLine())?.toLowerCase() === 'y' ? 'y' : 'n';
      console.log(`[approval] answer=${answer}`);
      record('approval_decision', { decision: answer === 'y' ? 'approved' : 'declined' });

      if (answer === 'y') {
        result.state.approve(item);
        await memoryStore.addAudit(applicantId, 'approved', `human approved ${action}`);
      } else {
        result.state.reject(item, { message: declineMessage(action) });
        await memoryStore.addAudit(applicantId, 'declined', `human declined ${action}`);
      }
    }

    // Round-trip through a string, as if the paused run had been stored and picked up later.
    const saved = result.state.toString();
    const keys = Object.keys(JSON.parse(saved));
    console.log(
      `[state] serialized ${Buffer.byteLength(saved)} bytes, top-level keys: ${keys.join(', ')}`,
    );
    const restored = await RunState.fromStringWithContext(
      startingAgent,
      saved,
      new RunContext(appContext),
    );
    result = await runner.run(startingAgent, restored, { session, maxTurns: MAX_TURNS });
    resumes++;
    reportSegment(`resume ${resumes}`, result);
  }
  return { result, resumes };
}

let turn = 0;

prompt();
for (let line = await nextLine(); line !== undefined; line = await nextLine()) {
  if (line === '') {
    prompt();
    continue;
  }
  if (line.toLowerCase() === 'exit') break;
  turn++;
  record('user_message', { text: line });

  // One trace per user message: the initial run, every approval resume and guardrail
  // handling all happen inside it, so a paused rejection lands in the same trace.
  await withTrace(
    'Recruiter chat turn',
    async (trace) => {
      console.log(`[trace] ${trace.traceId} group=${groupId}`);
      record('trace', { traceId: trace.traceId });
      // The blocking guardrail runs first thing in the run; its result is read afterwards and
      // recorded at this moment so the timeline stays in order.
      const runStartedAt = Date.now();
      const recordGuardrail = (results: InputGuardrailResult[]) => emitGuardrails(record, results, runStartedAt);
      try {
        // Triage routing: every message starts at Intake, which hands scheduling off one way
        // to the Scheduler. Measured against sticky routing (start at the last agent), triage
        // passed 21/21 checks vs 20/21, at ~21% more input tokens.
        // traceIncludeSensitiveData is left at its default (true): traces contain message text and
        // tool inputs and outputs. With real applicant data, set it to false or redact first.
        const first = await runner.run(startingAgent, line, {
          session,
          context: appContext,
          maxTurns: MAX_TURNS,
        });
        recordGuardrail(first.inputGuardrailResults);
        reportSegment('initial', first, topicUsageOf(first.inputGuardrailResults));
        if (first.interruptions.length > 0) console.log('[paused] waiting for human approval');

        const { result } = await resolveApprovals(first);
        const lastAgent = result.lastAgent ?? startingAgent;

        const reply = typeof result.finalOutput === 'string' ? result.finalOutput : '';
        if (reply.trim() === '') {
          console.log(`[warn] empty reply from ${lastAgent.name}`);
        } else {
          console.log(`Agent: ${reply}`);
          record('agent_reply', { agent: lastAgent.name, text: reply });
        }

        console.log(`[agent] ${lastAgent.name}`);
      } catch (error) {
        if (error instanceof InputGuardrailTripwireTriggered) {
          const reason = error.result.output.outputInfo?.reason ?? 'unknown';
          const offTopic = reason === 'off_topic';
          if (!offTopic) redactLastUserMessage();
          // Every blocking guardrail's result, not just the one that tripped.
          const results = error.state?._inputGuardrailResults ?? [error.result];
          recordGuardrail(results);
          const topic = topicUsageOf(results);
          if (topic) {
            addUsage(turnUsage, topic);
            addUsage(topicUsage, topic);
            console.log(`[usage] ${describeTopic(topic)}`);
            const requests = takeRequestCount();
            turnRequests += requests;
            console.log(`[http] topic_check model requests=${requests}`);
          }
          const blockedReply = offTopic
            ? OFF_TOPIC_REPLY
            : POLICY_REPLY;
          console.log(`Agent: ${blockedReply}`);
          record('agent_reply', { agent: startingAgent.name, text: blockedReply });
          console.log(`[guardrail] blocked (${reason})`);
        } else if (error instanceof MaxTurnsExceededError) {
          console.log('[error] max turns exceeded');
        } else {
          console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      record('turn_usage', { ...turnUsage, topicCheck: topicUsage });
      turnUsage = emptyUsage();
      topicUsage = emptyUsage();
      console.log(`[http] model requests this turn=${turnRequests + takeRequestCount()}`);
      turnRequests = 0;
      console.log(`[session] items=${(await session.getItems()).length}`);
    },
    { groupId, metadata: { turn: String(turn) } },
  );
  prompt();
}

rl.close();

for (const entry of await memoryStore.listAudit()) {
  console.log(`[audit] ${JSON.stringify(entry)}`);
}

// Upload buffered traces before exit; piped runs otherwise end before the batch is sent.
await getGlobalTraceProvider().forceFlush();
