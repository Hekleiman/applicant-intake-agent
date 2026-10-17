import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  RunContext,
  RunState,
  Runner,
  getGlobalTraceProvider,
  withTrace,
  type Agent,
  type CallModelInputFilter,
  type RunResult,
  type RunToolApprovalItem,
} from '@openai/agents';
import { waitUntil } from '@vercel/functions';
import { startingAgent } from '../agents/index.js';
import { LIVE_MODEL_SETTINGS } from '../agents/modelSettings.js';
import { applicantIdOf, approvalAction, declineMessage, parseArgs } from '../agents/approvals.js';
import { OFF_TOPIC_REPLY, POLICY_REPLY } from '../agents/replies.js';
import type { AppContext } from '../context.js';
import { SupabaseStore } from '../data/supabaseStore.js';
import { emitGuardrails } from '../lib/guardrailEvents.js';
import { attachToolEvents, EventCollector, type RunEvent, type Usage } from '../lib/runEvents.js';
import { addUsage, emptyUsage, fromSdkUsage, topicResponseIdsOf, topicUsageOf } from '../lib/usage.js';
import { PostgresSession } from '../memory/postgresSession.js';
import { HttpError } from './http.js';
import { finishUsage, isProduction } from './limits.js';
import { getState, type Interruption, type PendingApproval, type SandboxState } from './sandbox.js';
import { check, db } from './supabase.js';

const MAX_TURNS = 8;

type Result = RunResult<AppContext, Agent<AppContext, any>>;

export type TurnUsage = Usage & { topicCheck: Usage };

export type TurnResponse = {
  reply: string;
  agent: string | null;
  events: RunEvent[];
  usage: TurnUsage;
  // OpenAI response IDs of this turn's model calls. With store: false they can't be fetched
  // back; the smoke test checks that.
  responseIds: string[];
  pendingApproval: PendingApproval | null;
  state: SandboxState;
};

// Everything one request needs, created fresh per request: fluid compute runs several requests
// in one instance at once, so nothing request-specific lives at module level.
function newRequest(sandboxId: string) {
  const collector = new EventCollector();
  // Traces show steps and timings but no message text, tool arguments or tool results, and
  // store: false keeps OpenAI from storing the responses the trace dashboard would open in full.
  const runner = new Runner({ traceIncludeSensitiveData: false, modelSettings: LIVE_MODEL_SETTINGS });
  attachToolEvents(runner, collector.emit);
  return {
    collector,
    runner,
    session: new PostgresSession(sandboxId),
    store: new SupabaseStore(sandboxId),
    // Plain data only: this object ends up inside RunState.toString().
    context: { sandboxId } as AppContext,
    sandboxId,
    usage: { ...emptyUsage(), topicCheck: emptyUsage() } as TurnUsage,
    responseIds: [] as string[],
  };
}

type LiveRequest = ReturnType<typeof newRequest>;

const responseIdsOf = (result: Result) =>
  result.rawResponses.map((r) => r.responseId).filter((id): id is string => !!id);

const addMain = (req: LiveRequest, result: Result) => {
  addUsage(req.usage, fromSdkUsage(result.state.usage));
  req.responseIds.push(...responseIdsOf(result));
};

const addTopic = (req: LiveRequest, results: Result['inputGuardrailResults']) => {
  req.responseIds.push(...topicResponseIdsOf(results));
  const topic = topicUsageOf(results);
  if (!topic) return;
  addUsage(req.usage, topic);
  addUsage(req.usage.topicCheck, topic);
};

const callIdOf = (item: RunToolApprovalItem): string =>
  'callId' in item.rawItem && typeof item.rawItem.callId === 'string' ? item.rawItem.callId : (item.rawItem.id ?? '');

async function describePending(req: LiveRequest, interruptions: Interruption[]): Promise<string> {
  const parts = await Promise.all(
    interruptions.map(async (i) => {
      const applicant = await req.store.getApplicant(applicantIdOf(i.args));
      const who = applicant?.name ?? applicantIdOf(i.args);
      return i.action === 'offer' ? `make ${who} an offer` : `reject ${who}`;
    }),
  );
  return `I need a recruiter's approval before I ${parts.join(' and ')}. Use Approve or Decline in the "Waiting for your approval" panel.`;
}

// Turns a finished or paused run into the reply. A paused run is stored in paused_runs; its
// RunState string never leaves the server.
async function settle(req: LiveRequest, result: Result): Promise<{ reply: string; agent: string | null; pending: PendingApproval | null }> {
  const agent = result.lastAgent?.name ?? startingAgent.name;
  if (result.interruptions.length === 0) {
    const reply = typeof result.finalOutput === 'string' ? result.finalOutput : '';
    return { reply: reply.trim() || 'Done.', agent, pending: null };
  }

  const interruptions: Interruption[] = result.interruptions.map((item) => {
    const args = parseArgs(item.arguments);
    return {
      callId: callIdOf(item),
      tool: item.name ?? 'unknown',
      args,
      agent: item.agent.name,
      action: approvalAction(item.name, args),
    };
  });
  for (const i of interruptions) {
    req.collector.emit('approval_requested', { agent: i.agent, tool: i.tool, args: i.args });
    if (i.action === 'rejection') {
      const reason = (i.args as { reason?: unknown })?.reason;
      await req.store.addAudit(applicantIdOf(i.args), 'rejection_requested', typeof reason === 'string' ? reason : '');
    } else {
      await req.store.addAudit(applicantIdOf(i.args), 'offer_requested', 'offer');
    }
  }
  const row = check(
    await db()
      .from('paused_runs')
      .insert({ sandbox_id: req.sandboxId, interruptions, run_state: result.state.toString() })
      .select('id, created_at')
      .single(),
    'store paused run',
  ) as { id: string; created_at: string };
  return {
    reply: await describePending(req, interruptions),
    agent,
    pending: { pausedRunId: row.id, createdAt: row.created_at, interruptions },
  };
}

async function respond(req: LiveRequest, out: { reply: string; agent: string | null; pending: PendingApproval | null }): Promise<TurnResponse> {
  return {
    reply: out.reply,
    agent: out.agent,
    events: req.collector.events,
    usage: req.usage,
    responseIds: [...new Set(req.responseIds)],
    pendingApproval: out.pending,
    state: await getState(req.sandboxId),
  };
}

// Export buffered traces without delaying the response; waitUntil keeps the function alive
// until the export finishes.
const flushTraces = () => waitUntil(getGlobalTraceProvider().forceFlush());

export async function chatTurn(sandboxId: string, message: string, usageId: number): Promise<TurnResponse> {
  const req = newRequest(sandboxId);
  let out: { reply: string; agent: string | null; pending: PendingApproval | null };
  try {
    out = await withTrace(
      'Live recruiter chat turn',
      async () => {
        const runStartedAt = Date.now();
        try {
          const result: Result = await req.runner.run(startingAgent, message, {
            session: req.session,
            context: req.context,
            maxTurns: MAX_TURNS,
          });
          emitGuardrails(req.collector.emit, result.inputGuardrailResults, runStartedAt);
          addTopic(req, result.inputGuardrailResults);
          addMain(req, result);
          return await settle(req, result);
        } catch (error) {
          if (!(error instanceof InputGuardrailTripwireTriggered)) throw error;
          // Blocked: the SDK saves nothing to the session, and the fixed reply isn't saved either.
          const results = error.state?._inputGuardrailResults ?? [error.result];
          emitGuardrails(req.collector.emit, results, runStartedAt);
          addTopic(req, results);
          const offTopic = error.result.output.outputInfo?.reason === 'off_topic';
          return { reply: offTopic ? OFF_TOPIC_REPLY : POLICY_REPLY, agent: startingAgent.name, pending: null };
        }
      },
      { groupId: sandboxId },
    );
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      throw new HttpError(500, 'The assistant took too many steps on that request. Please try a simpler request.');
    }
    throw error;
  } finally {
    await finishUsage(usageId, req.usage);
    flushTraces();
  }
  return respond(req, out);
}

export type Decision = { callId: string; approve: boolean };

// Test only, ignored in production. LIVE_TEST_FAIL_RESUME makes an approval fail on purpose:
// before_decision fails just before the resumed run starts (nothing has taken effect);
// after_decision fails at the resumed run's first model call, after the approved tool ran (or the
// decline was recorded) and before the reply.
const testFailMode = (): string | undefined => (isProduction() ? undefined : process.env.LIVE_TEST_FAIL_RESUME);

function testFailureHook(): { callModelInputFilter?: CallModelInputFilter } {
  if (testFailMode() !== 'after_decision') return {};
  return {
    callModelInputFilter: () => {
      throw new Error('LIVE_TEST_FAIL_RESUME: simulated failure before the reply');
    },
  };
}

// Which of these tool calls already have a result in the session. A resumed run writes the
// approved tool's result (or the decline message) to the session before it calls the model again.
async function callsWithResult(req: LiveRequest, callIds: string[]): Promise<Set<string>> {
  const wanted = new Set(callIds);
  const done = new Set<string>();
  for (const item of await req.session.getItems()) {
    if (item.type === 'function_call_result' && wanted.has(item.callId)) done.add(item.callId);
  }
  return done;
}

// Every function_call in the session needs a result, or the next run is refused. Used after a
// failed resume for any call that never got one.
const NOT_CARRIED_OUT = 'Not carried out: the server failed while handling the approval. Nothing changed for this request.';

const RECOVERED_REPLY = (done: string[]) =>
  `Your decision was saved: ${done.join(' and ')}. The assistant's reply didn't finish because of a server error, but the board and Activity show the current status. You can keep chatting.`;

export async function resolveApproval(
  sandboxId: string,
  pausedRunId: string,
  decisions: Decision[],
  usageId: number,
): Promise<TurnResponse> {
  const req = newRequest(sandboxId);

  // Claim the row atomically: only one request can move it from pending to resolving.
  const claimed = check(
    await db()
      .from('paused_runs')
      .update({ status: 'resolving' })
      .eq('id', pausedRunId)
      .eq('sandbox_id', sandboxId)
      .eq('status', 'pending')
      .select('id, run_state, interruptions'),
    'claim paused run',
  ) as { id: string; run_state: string; interruptions: Interruption[] }[];
  const row = claimed[0];
  if (!row) throw new HttpError(409, 'This approval was already handled.');

  const markResolved = async () =>
    check(
      await db().from('paused_runs').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', row.id),
      'resolve paused run',
    );
  // Puts the row back to pending, so the visitor can try the decision again. Only safe while no
  // decision has taken effect.
  const release = async () => {
    const result = await db().from('paused_runs').update({ status: 'pending' }).eq('id', row.id);
    if (result.error) console.error(`[api] release paused run ${row.id} failed: ${result.error.message}`);
  };

  const byCall = new Map(decisions.map((d) => [d.callId, d.approve]));
  const expected = row.interruptions.map((i) => i.callId);
  if (byCall.size !== expected.length || !expected.every((id) => byCall.has(id))) {
    await release();
    throw new HttpError(400, 'Every pending request needs exactly one decision: approve or decline.');
  }

  const decided = row.interruptions.map((i) => ({
    callId: i.callId,
    applicantId: applicantIdOf(i.args),
    action: i.action,
    approve: byCall.get(i.callId) === true,
  }));
  // The audit log is append-only. A decision's "approved" or "declined" row is written only once
  // that decision has taken effect: after the resumed run completes, or when the recovery check
  // finds its result in the session. A decision that never took effect gets no row.
  const auditDecisions = async (callIds: Set<string>) => {
    const rows = decided
      .filter((d) => callIds.has(d.callId))
      .map((d) => ({
        sandbox_id: sandboxId,
        applicant_id: d.applicantId,
        action: d.approve ? 'approved' : 'declined',
        detail: `${d.action} ${d.approve ? 'approved' : 'declined'} by a human`,
      }));
    if (rows.length > 0) check(await db().from('audit_log').insert(rows), 'add audit entries');
  };

  let out: { reply: string; agent: string | null; pending: PendingApproval | null };
  let result: Result;
  try {
    // No withTrace here. The restored RunState carries the trace of the chat turn that paused it
    // (RunState._trace), and the runner resumes inside that trace
    // (node_modules/@openai/agents-core/dist/run.js lines 428 to 432), so the resumed spans land in
    // the original "Live recruiter chat turn" trace: one trace covers the request, the pause and
    // the resume. A separate trace opened here stayed empty.
    //
    // The stored state is trusted because it never left the server. The context is rebuilt
    // from plain data, so no client or key could have been serialized into it.
    const state = await RunState.fromStringWithContext(startingAgent, row.run_state, new RunContext<AppContext>(req.context));
    for (const item of state.getInterruptions()) {
      const approve = byCall.get(callIdOf(item));
      if (approve) state.approve(item);
      else state.reject(item, { message: declineMessage(approvalAction(item.name, parseArgs(item.arguments))) });
      req.collector.emit('approval_decision', { decision: approve ? 'approved' : 'declined', tool: item.name });
    }
    if (testFailMode() === 'before_decision') throw new Error('LIVE_TEST_FAIL_RESUME: simulated failure before the run');
    result = await req.runner.run(startingAgent, state, {
      session: req.session,
      maxTurns: MAX_TURNS,
      ...testFailureHook(),
    });
    await auditDecisions(new Set(expected));
  } catch (error) {
    // A resume can fail after a decision took effect: the approved tool already ran (or the
    // decline was recorded) and its result is in the session, but the model's reply never came.
    // Putting the row back to pending then let a retry run the tool a second time and add a
    // second result for the same call, and a retry could even flip a decline into an approval.
    // So once any decision has a result in the session, it is final: the row is resolved, calls
    // without a result get a "not carried out" one so the next chat run is valid, and the
    // visitor is told what happened. Only when nothing took effect does the row go back to
    // pending for a clean retry; that attempt is logged here and never written to the audit log.
    try {
      const done = await callsWithResult(req, expected);
      if (done.size === 0) {
        console.error('[api] approval failed before any decision took effect; back to pending:', {
          sandboxId,
          pausedRunId: row.id,
          decisions: decided.map((d) => `${d.action} ${d.approve ? 'approved' : 'declined'}`),
          error: error instanceof Error ? error.message : String(error),
        });
        await release();
      } else {
        const missing = row.interruptions.filter((i) => !done.has(i.callId));
        await req.session.addItems(
          missing.map((i) => ({
            type: 'function_call_result' as const,
            name: i.tool,
            callId: i.callId,
            status: 'completed' as const,
            output: { type: 'text' as const, text: NOT_CARRIED_OUT },
          })),
        );
        await markResolved();
        await auditDecisions(done);
        console.error(`[api] approval ${row.id} failed after its decision took effect; resolved without a reply:`, error instanceof Error ? error.message : error);
        const said = await Promise.all(
          decided
            .filter((d) => done.has(d.callId))
            .map(async (d) => {
              const name = (await req.store.getApplicant(d.applicantId))?.name ?? d.applicantId;
              const what = d.action === 'offer' ? `the offer for ${name}` : `the rejection of ${name}`;
              return `${d.approve ? 'you approved' : 'you declined'} ${what}`;
            }),
        );
        await finishUsage(usageId, req.usage);
        flushTraces();
        return respond(req, { reply: RECOVERED_REPLY(said), agent: null, pending: null });
      }
    } catch (recoveryError) {
      console.error(`[api] recovering approval ${row.id} failed:`, recoveryError instanceof Error ? recoveryError.message : recoveryError);
    }
    await finishUsage(usageId, req.usage);
    flushTraces();
    if (error instanceof MaxTurnsExceededError) {
      throw new HttpError(500, 'The assistant took too many steps on that request. Please try again.');
    }
    throw error;
  }

  try {
    addMain(req, result);
    await markResolved();
    out = await settle(req, result);
  } finally {
    await finishUsage(usageId, req.usage);
    flushTraces();
  }
  return respond(req, out);
}
