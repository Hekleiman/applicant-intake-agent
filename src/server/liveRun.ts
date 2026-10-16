import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  RunContext,
  RunState,
  Runner,
  getGlobalTraceProvider,
  withTrace,
  type Agent,
  type RunResult,
  type RunToolApprovalItem,
} from '@openai/agents';
import { waitUntil } from '@vercel/functions';
import { startingAgent } from '../agents/index.js';
import { applicantIdOf, approvalAction, declineMessage, parseArgs } from '../agents/approvals.js';
import { OFF_TOPIC_REPLY, POLICY_REPLY } from '../agents/replies.js';
import type { AppContext } from '../context.js';
import { SupabaseStore } from '../data/supabaseStore.js';
import { emitGuardrails } from '../lib/guardrailEvents.js';
import { attachToolEvents, EventCollector, type RunEvent, type Usage } from '../lib/runEvents.js';
import { addUsage, emptyUsage, fromSdkUsage, topicUsageOf } from '../lib/usage.js';
import { PostgresSession } from '../memory/postgresSession.js';
import { HttpError } from './http.js';
import { finishUsage } from './limits.js';
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
  pendingApproval: PendingApproval | null;
  state: SandboxState;
};

// Everything one request needs, created fresh per request: fluid compute runs several requests
// in one instance at once, so nothing request-specific lives at module level.
function newRequest(sandboxId: string) {
  const collector = new EventCollector();
  // Traces show steps and timings but no message text, tool arguments or tool results.
  const runner = new Runner({ traceIncludeSensitiveData: false });
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
  };
}

type LiveRequest = ReturnType<typeof newRequest>;

const addMain = (req: LiveRequest, result: Result) => addUsage(req.usage, fromSdkUsage(result.state.usage));

const addTopic = (req: LiveRequest, topic: Usage | undefined) => {
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
          addTopic(req, topicUsageOf(result.inputGuardrailResults));
          addMain(req, result);
          return await settle(req, result);
        } catch (error) {
          if (!(error instanceof InputGuardrailTripwireTriggered)) throw error;
          // Blocked: the SDK saves nothing to the session, and the fixed reply isn't saved either.
          const results = error.state?._inputGuardrailResults ?? [error.result];
          emitGuardrails(req.collector.emit, results, runStartedAt);
          addTopic(req, topicUsageOf(results));
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

  let resolved = false;
  // Puts the row back to pending after a failure, so the visitor can try the decision again.
  const release = async () => {
    if (resolved) return;
    const result = await db().from('paused_runs').update({ status: 'pending' }).eq('id', row.id);
    if (result.error) console.error(`[api] release paused run ${row.id} failed: ${result.error.message}`);
  };

  const byCall = new Map(decisions.map((d) => [d.callId, d.approve]));
  const expected = row.interruptions.map((i) => i.callId);
  if (byCall.size !== expected.length || !expected.every((id) => byCall.has(id))) {
    await release();
    throw new HttpError(400, 'Every pending request needs exactly one decision: approve or decline.');
  }

  let out: { reply: string; agent: string | null; pending: PendingApproval | null };
  try {
    out = await withTrace(
      'Live recruiter approval',
      async () => {
        // The stored state is trusted because it never left the server. The context is rebuilt
        // from plain data, so no client or key could have been serialized into it.
        const state = await RunState.fromStringWithContext(startingAgent, row.run_state, new RunContext<AppContext>(req.context));
        for (const item of state.getInterruptions()) {
          const approve = byCall.get(callIdOf(item));
          const args = parseArgs(item.arguments);
          const action = approvalAction(item.name, args);
          const applicantId = applicantIdOf(args);
          if (approve) {
            state.approve(item);
            await req.store.addAudit(applicantId, 'approved', `${action} approved by a human`);
          } else {
            state.reject(item, { message: declineMessage(action) });
            await req.store.addAudit(applicantId, 'declined', `${action} declined by a human`);
          }
          req.collector.emit('approval_decision', { decision: approve ? 'approved' : 'declined', tool: item.name });
        }
        const result: Result = await req.runner.run(startingAgent, state, { session: req.session, maxTurns: MAX_TURNS });
        addMain(req, result);
        check(
          await db().from('paused_runs').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', row.id),
          'resolve paused run',
        );
        resolved = true;
        return settle(req, result);
      },
      { groupId: sandboxId },
    );
  } catch (error) {
    await release();
    if (error instanceof MaxTurnsExceededError) {
      throw new HttpError(500, 'The assistant took too many steps on that request. Please try again.');
    }
    throw error;
  } finally {
    await finishUsage(usageId, req.usage);
    flushTraces();
  }
  return respond(req, out);
}
