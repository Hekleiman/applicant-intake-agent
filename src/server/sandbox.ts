import { randomUUID } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import type { StoredScreening } from '../agents/screener.js';
import { applicants as seedApplicants } from '../data/applicants.js';
import { SLOTS, type Slot } from '../data/slots.js';
import { SupabaseStore } from '../data/supabaseStore.js';
import { PostgresSession } from '../memory/postgresSession.js';
import { describeAudit } from './activity.js';
import { check, db } from './supabase.js';
import { HttpError } from './http.js';

export const MAX_APPLICANTS = 25;
const AUDIT_ENTRIES = 30;

// What the browser gets about a paused run: never run_state.
export type Interruption = {
  callId: string;
  tool: string;
  args: unknown;
  agent: string;
  action: 'rejection' | 'offer';
};

export type PendingApproval = { pausedRunId: string; createdAt: string; interruptions: Interruption[] };

// Live sandbox only: Devon Park starts in Interview scheduled, so he holds a slot. The CLI seed
// and the recordings have no bookings and stay as they are.
const SEED_BOOKINGS: { slot: Slot; applicantId: string }[] = [{ slot: 'Wed 09:30', applicantId: 'A-1002' }];

// The version of the seed data a new sandbox gets. Bump it, and add the time the new seed went
// live in production below, whenever the seed changes. The version is worked out from the
// sandbox's created_at, so it needs no column: a sandbox created before a version went live has
// the older seed. The page starts a fresh sandbox (same as Start over) when its sandbox's version
// is older than SEED_VERSION.
//   1: the original five applicants, no bookings.
//   2: Devon Park holds Wed 09:30 (commit b2d225a, production deployment Ready at 00:52:56 UTC).
export const SEED_VERSION = 2;
const SEED_LIVE_AT: Record<number, string> = { 2: '2026-10-17T00:52:57Z' };

export function seedVersionOf(createdAt: string): number {
  let version = 1;
  for (const [v, at] of Object.entries(SEED_LIVE_AT)) {
    if (Date.parse(createdAt) >= Date.parse(at)) version = Math.max(version, Number(v));
  }
  return version;
}

async function sandboxSeedVersion(sandboxId: string): Promise<number | null> {
  const row = check(
    await db().from('sandboxes').select('created_at').eq('id', sandboxId).maybeSingle(),
    'get sandbox',
  ) as { created_at: string } | null;
  return row ? seedVersionOf(row.created_at) : null;
}

// A screening still running after this long has failed (functions stop after 60 seconds).
const SCREENING_TIMEOUT_MS = 90_000;

// A new sandbox with a fresh copy of the five fake applicants and Devon's booking.
export async function createSandbox(): Promise<string> {
  const id = randomUUID();
  check(await db().from('sandboxes').insert({ id }), 'create sandbox');
  check(
    await db()
      .from('applicants')
      .insert(
        seedApplicants.map((a) => ({
          sandbox_id: id,
          id: a.id,
          name: a.name,
          role: a.role,
          stage: a.stage,
          applied_on: a.appliedOn,
          notes: a.notes,
        })),
      ),
    'seed applicants',
  );
  check(
    await db()
      .from('bookings')
      .insert(SEED_BOOKINGS.map((b) => ({ sandbox_id: id, slot: b.slot, applicant_id: b.applicantId }))),
    'seed bookings',
  );
  return id;
}

// Marks the sandbox as active. Returns false when it doesn't exist (never created, reset, or
// deleted after 24 hours without activity).
export async function touchSandbox(id: string): Promise<boolean> {
  const rows = check(
    await db().from('sandboxes').update({ last_seen_at: new Date().toISOString() }).eq('id', id).select('id'),
    'touch sandbox',
  ) as { id: string }[];
  return rows.length > 0;
}

export async function requireSandbox(id: string): Promise<void> {
  if (!(await touchSandbox(id))) {
    throw new HttpError(404, 'This sandbox no longer exists. Reload the page to start a fresh one.');
  }
}

export async function deleteSandbox(id: string): Promise<void> {
  check(await db().from('sandboxes').delete().eq('id', id), 'delete sandbox');
}

// Paused runs that block new chat messages: waiting for a decision, or being resumed right now.
export async function openPausedRuns(sandboxId: string) {
  return check(
    await db()
      .from('paused_runs')
      .select('id, status, created_at, interruptions')
      .eq('sandbox_id', sandboxId)
      .in('status', ['pending', 'resolving'])
      .order('created_at', { ascending: true }),
    'list paused runs',
  ) as { id: string; status: 'pending' | 'resolving'; created_at: string; interruptions: Interruption[] }[];
}

export type ScreeningStatus = 'running' | 'done' | 'failed';
export type ScreeningView = { status: ScreeningStatus; result: StoredScreening | null };
export type ConversationMessage = { role: 'user' | 'assistant'; text: string };

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
};

// The visible conversation: user and assistant message text only, in order. Tool calls, tool
// results and handoffs stay on the server.
export function conversationOf(items: AgentInputItem[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('role' in item)) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if ('type' in item && item.type !== undefined && item.type !== 'message') continue;
    const text = textOf(item.content).trim();
    if (text) messages.push({ role: item.role, text });
  }
  return messages;
}

export async function getState(sandboxId: string) {
  const store = new SupabaseStore(sandboxId);
  const [applicants, bookings, audit, paused, screeningRows, items, seedVersion] = await Promise.all([
    store.listApplicants(),
    store.listBookings(),
    store.listAudit(AUDIT_ENTRIES),
    openPausedRuns(sandboxId),
    store.listScreenings(),
    new PostgresSession(sandboxId).getItems(),
    sandboxSeedVersion(sandboxId),
  ]);
  const names = new Map(applicants.map((a) => [a.id, a.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const screenings: Record<string, ScreeningView> = {};
  for (const [id, r] of Object.entries(screeningRows)) {
    if (!r.hasResume) continue;
    const running = !r.screening && !r.screenedAt && Date.now() - Date.parse(r.createdAt) < SCREENING_TIMEOUT_MS;
    screenings[id] = { status: r.screening ? 'done' : running ? 'running' : 'failed', result: r.screening };
  }
  const taken = new Set(bookings.map((b) => b.slot));
  const pendingApprovals: PendingApproval[] = paused
    .filter((p) => p.status === 'pending')
    .map((p) => ({ pausedRunId: p.id, createdAt: p.created_at, interruptions: p.interruptions }));
  return {
    applicants,
    bookings,
    openSlots: SLOTS.filter((s) => !taken.has(s)),
    pendingApprovals,
    audit: audit.map((e) => ({ ...e, text: describeAudit(e, nameOf) })),
    screenings,
    conversation: conversationOf(items),
    seedVersion,
    currentSeedVersion: SEED_VERSION,
  };
}

export type SandboxState = Awaited<ReturnType<typeof getState>>;
