import type { ResumeSource, StoredScreening } from '../agents/screener.js';
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
  type ScreeningRecord,
  type Stage,
  type Store,
  todayInTimeZone,
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
          applied_on: todayInTimeZone(),
          notes: input.notes,
          resume_text: input.resumeText ?? null,
          // Written by our server at upload, before any model call, so a retry after a failed
          // screening still knows whether the resume was cut and how long it was.
          screening: input.resumeText != null && input.resumeSource ? { source: input.resumeSource } : null,
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

  async cancelBooking(applicantId: string) {
    check(
      await db().from('bookings').delete().eq('sandbox_id', this.sandboxId).eq('applicant_id', applicantId),
      'cancel booking',
    );
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
      // By time, then by insert order: a decision's row is written after its result but carries
      // the time of the click, so it sorts before the result.
      .order('at', { ascending: false })
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

  // PostgREST can't select an expression, so "has a resume" is a second query filtered on
  // resume_text that returns only IDs; the text itself is never read here.
  private async idsWithResume(id?: string): Promise<Set<string>> {
    let query = db().from('applicants').select('id').eq('sandbox_id', this.sandboxId).not('resume_text', 'is', null);
    if (id !== undefined) query = query.eq('id', id.trim());
    const rows = check(await query, 'list resumes') as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  async getScreening(id: string): Promise<ScreeningRecord | null> {
    const [row, withResume] = await Promise.all([
      db()
        .from('applicants')
        .select('id, screening, screened_at')
        .eq('sandbox_id', this.sandboxId)
        .eq('id', id.trim())
        .maybeSingle()
        .then((r) => check(r, 'get screening') as ScreeningRow | null),
      this.idsWithResume(id),
    ]);
    return row ? toScreening(row, withResume) : null;
  }

  // Every applicant's screening, for the board. Never selects the resume text.
  async listScreenings(): Promise<Record<string, ScreeningRecord & { createdAt: string }>> {
    const [rows, withResume] = await Promise.all([
      db()
        .from('applicants')
        .select('id, created_at, screening, screened_at')
        .eq('sandbox_id', this.sandboxId)
        .then((r) => check(r, 'list screenings') as (ScreeningRow & { created_at: string })[]),
      this.idsWithResume(),
    ]);
    return Object.fromEntries(rows.map((r) => [r.id, { ...toScreening(r, withResume), createdAt: r.created_at }]));
  }

  // Server only: the text goes to the Screener and nowhere else.
  async getResumeText(id: string): Promise<string | null> {
    const row = check(
      await db().from('applicants').select('resume_text').eq('sandbox_id', this.sandboxId).eq('id', id.trim()).maybeSingle(),
      'get resume text',
    ) as { resume_text: string | null } | null;
    return row?.resume_text ?? null;
  }

  // What extraction recorded at upload: the screening column's server-written source block.
  // Null for a resume uploaded before the block existed.
  async getResumeSource(id: string): Promise<ResumeSource | null> {
    const row = check(
      await db().from('applicants').select('screening').eq('sandbox_id', this.sandboxId).eq('id', id.trim()).maybeSingle(),
      'get resume source',
    ) as { screening: ScreeningColumn | null } | null;
    return row?.screening?.source ?? null;
  }

  // A finished screening, or null after a failed attempt; either way screened_at records when.
  // The source block is written back with it, so it survives a failure.
  async saveScreening(id: string, screening: StoredScreening | null, source: ResumeSource) {
    check(
      await db()
        .from('applicants')
        .update({ screening: { ...screening, source }, screened_at: new Date().toISOString() })
        .eq('sandbox_id', this.sandboxId)
        .eq('id', id.trim()),
      'save screening',
    );
  }

  // Before a retry: back to "not attempted yet", so other tabs show it as running. Keeps the
  // source block.
  async clearScreening(id: string, source: ResumeSource) {
    check(
      await db()
        .from('applicants')
        .update({ screening: { source }, screened_at: null })
        .eq('sandbox_id', this.sandboxId)
        .eq('id', id.trim()),
      'clear screening',
    );
  }
}

// applicants.screening holds the model's result (when a screening finished) plus the server's
// source block. A row with only the source block has no screening yet.
type ScreeningColumn = Partial<StoredScreening> & { source?: ResumeSource };
type ScreeningRow = { id: string; screening: ScreeningColumn | null; screened_at: string | null };

const screeningOf = (column: ScreeningColumn | null): StoredScreening | null => {
  if (!column || column.fit === undefined) return null;
  const { source: _source, ...screening } = column;
  return screening as StoredScreening;
};

const toScreening = (row: ScreeningRow, withResume: Set<string>): ScreeningRecord => ({
  hasResume: withResume.has(row.id),
  screening: screeningOf(row.screening),
  screenedAt: row.screened_at,
});
