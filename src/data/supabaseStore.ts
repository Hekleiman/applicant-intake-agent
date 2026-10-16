import { check, db, UNIQUE_VIOLATION } from '../server/supabase.js';
import type { Applicant } from './applicants.js';
import { SLOTS, isSlot, type Slot } from './slots.js';
import {
  nextApplicantId,
  type AuditAction,
  type AuditEntry,
  type BookSlotResult,
  type Booking,
  type NewApplicant,
  type Stage,
  type Store,
} from './store.js';

type ApplicantRow = {
  id: string;
  name: string;
  role: string;
  stage: Stage;
  applied_on: string;
  notes: string;
};

const APPLICANT_COLUMNS = 'id, name, role, stage, applied_on, notes';

// Same shape and key order as the in-memory applicants, so tool results look the same.
const toApplicant = (row: ApplicantRow): Applicant => ({
  id: row.id,
  name: row.name,
  role: row.role,
  stage: row.stage,
  appliedOn: row.applied_on,
  notes: row.notes,
});

const byId = (a: Applicant, b: Applicant) => a.id.localeCompare(b.id, 'en', { numeric: true });

// The Store for one live sandbox. Every query is filtered on the sandbox ID.
export class SupabaseStore implements Store {
  constructor(private readonly sandboxId: string) {}

  async listApplicants() {
    const rows = check(
      await db().from('applicants').select(APPLICANT_COLUMNS).eq('sandbox_id', this.sandboxId),
      'list applicants',
    ) as ApplicantRow[];
    return rows.map(toApplicant).sort(byId);
  }

  // A sandbox holds at most 25 applicants, so matching in code is cheap and keeps user text
  // out of PostgREST filter syntax.
  async findApplicants(query: string) {
    const q = query.trim().toLowerCase();
    return (await this.listApplicants()).filter(
      (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
    );
  }

  async getApplicant(id: string) {
    const row = check(
      await db()
        .from('applicants')
        .select(APPLICANT_COLUMNS)
        .eq('sandbox_id', this.sandboxId)
        .eq('id', id.trim())
        .maybeSingle(),
      'get applicant',
    ) as ApplicantRow | null;
    return row ? toApplicant(row) : null;
  }

  // The primary key (sandbox_id, id) settles a race for the same next ID; the loser retries.
  async addApplicant(input: NewApplicant) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ids = (await this.listApplicants()).map((a) => a.id);
      const result = await db()
        .from('applicants')
        .insert({
          sandbox_id: this.sandboxId,
          id: nextApplicantId(ids),
          name: input.name,
          role: input.role,
          stage: 'applied',
          notes: input.notes,
        })
        .select(APPLICANT_COLUMNS)
        .single();
      if (result.error?.code === UNIQUE_VIOLATION) continue;
      return toApplicant(check(result, 'add applicant') as ApplicantRow);
    }
    throw new Error('add applicant: could not assign an ID');
  }

  async setStage(id: string, stage: Stage, from?: Stage[]) {
    let query = db()
      .from('applicants')
      .update({ stage })
      .eq('sandbox_id', this.sandboxId)
      .eq('id', id.trim());
    if (from) query = query.in('stage', from);
    const rows = check(await query.select('id'), 'set stage') as { id: string }[];
    return rows.length > 0;
  }

  async listBookings(): Promise<Booking[]> {
    const rows = check(
      await db().from('bookings').select('slot, applicant_id').eq('sandbox_id', this.sandboxId),
      'list bookings',
    ) as { slot: string; applicant_id: string }[];
    return rows
      .filter((r): r is { slot: Slot; applicant_id: string } => isSlot(r.slot))
      .map((r) => ({ slot: r.slot, applicantId: r.applicant_id }))
      .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  }

  async openSlots() {
    const taken = new Set((await this.listBookings()).map((b) => b.slot));
    return SLOTS.filter((s) => !taken.has(s));
  }

  // The database decides: the primary key (sandbox_id, slot) and unique (sandbox_id,
  // applicant_id) reject a second booking with 23505, so two racing requests can't both win.
  // On a conflict, "already booked" is checked first, the same order as the in-memory store.
  async bookSlot(applicantId: string, slot: Slot): Promise<BookSlotResult> {
    const result = await db()
      .from('bookings')
      .insert({ sandbox_id: this.sandboxId, slot, applicant_id: applicantId });
    if (!result.error) return { ok: true };
    if (result.error.code !== UNIQUE_VIOLATION) check(result, 'book slot');
    const current = (await this.listBookings()).find((b) => b.applicantId === applicantId);
    if (current) return { ok: false, reason: 'already booked', currentSlot: current.slot };
    return { ok: false, reason: 'slot taken' };
  }

  async addAudit(applicantId: string, action: AuditAction, detail: string) {
    check(
      await db()
        .from('audit_log')
        .insert({ sandbox_id: this.sandboxId, applicant_id: applicantId, action, detail: detail.slice(0, 500) }),
      'add audit entry',
    );
  }

  async listAudit(limit?: number) {
    let query = db()
      .from('audit_log')
      .select('at, applicant_id, action, detail')
      .eq('sandbox_id', this.sandboxId)
      .order('id', { ascending: false });
    if (limit !== undefined) query = query.limit(limit);
    const rows = check(await query, 'list audit log') as {
      at: string;
      applicant_id: string;
      action: AuditAction;
      detail: string;
    }[];
    return rows
      .reverse()
      .map((r): AuditEntry => ({ at: r.at, applicantId: r.applicant_id, action: r.action, detail: r.detail }));
  }
}
