import { randomUUID } from 'node:crypto';
import { applicants as seedApplicants } from '../data/applicants.js';
import { SLOTS } from '../data/slots.js';
import { SupabaseStore } from '../data/supabaseStore.js';
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

// A new sandbox with a fresh copy of the five fake applicants and no bookings.
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

export async function getState(sandboxId: string) {
  const store = new SupabaseStore(sandboxId);
  const [applicants, bookings, audit, paused] = await Promise.all([
    store.listApplicants(),
    store.listBookings(),
    store.listAudit(AUDIT_ENTRIES),
    openPausedRuns(sandboxId),
  ]);
  const taken = new Set(bookings.map((b) => b.slot));
  const pendingApprovals: PendingApproval[] = paused
    .filter((p) => p.status === 'pending')
    .map((p) => ({ pausedRunId: p.id, createdAt: p.created_at, interruptions: p.interruptions }));
  return {
    applicants,
    bookings,
    openSlots: SLOTS.filter((s) => !taken.has(s)),
    pendingApprovals,
    audit,
  };
}

export type SandboxState = Awaited<ReturnType<typeof getState>>;
