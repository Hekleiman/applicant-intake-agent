import type { StoredScreening } from '../agents/screener.js';
import type { Applicant } from './applicants.js';
import type { Slot } from './slots.js';

export type Stage = Applicant['stage'];

export type AuditAction =
  | 'added'
  | 'stage_changed'
  | 'booked'
  | 'rejection_requested'
  | 'offer_requested'
  | 'screened'
  | 'approved'
  | 'declined'
  | 'rejected';

export type AuditEntry = {
  at: string; // ISO timestamp
  applicantId: string;
  action: AuditAction;
  detail: string;
};

export type Booking = { slot: Slot; applicantId: string };

// resumeText is the extracted text of an uploaded resume (live sandbox only). It is stored for
// the Screener and never returned by any tool.
export type NewApplicant = { name: string; role: string; notes: string; resumeText?: string | null };

// An applicant's resume screening. screening is null until a screening finishes; screenedAt is
// the time of the last attempt, so a resume with screenedAt set and no screening means the last
// attempt failed.
export type ScreeningRecord = { hasResume: boolean; screening: StoredScreening | null; screenedAt: string | null };

// Result of trying to take a slot. The store decides "taken" and "already booked"; the caller
// has already checked that the applicant exists and is not rejected.
export type BookSlotResult =
  | { ok: true }
  | { ok: false; reason: 'already booked'; currentSlot: Slot }
  | { ok: false; reason: 'slot taken' };

// Everything the tools and the API read or write. Every method is async so the in-memory store
// (CLI) and the Postgres store (live sandbox) are interchangeable.
export interface Store {
  // Exact ID match or case-insensitive substring of the name.
  findApplicants(query: string): Promise<Applicant[]>;
  getApplicant(id: string): Promise<Applicant | null>;
  listApplicants(): Promise<Applicant[]>;
  // Assigns the next ID in this store, A-1006 and up.
  addApplicant(input: NewApplicant): Promise<Applicant>;
  // Compare-and-set: only changes the stage when the current stage is one of `from`.
  // Returns false when the applicant is missing or in another stage.
  setStage(id: string, stage: Stage, from?: Stage[]): Promise<boolean>;
  openSlots(): Promise<Slot[]>;
  bookSlot(applicantId: string, slot: Slot): Promise<BookSlotResult>;
  // Frees the applicant's slot, if they hold one. Used when an applicant is rejected.
  cancelBooking(applicantId: string): Promise<void>;
  listBookings(): Promise<Booking[]>;
  addAudit(applicantId: string, action: AuditAction, detail: string): Promise<void>;
  // Oldest first; with a limit, the newest `limit` entries.
  listAudit(limit?: number): Promise<AuditEntry[]>;
  // Null when the applicant doesn't exist. Never includes the resume text.
  getScreening(id: string): Promise<ScreeningRecord | null>;
}

export const FIRST_NEW_ID = 1006;

export const nextApplicantId = (existing: string[]): string => {
  const numbers = existing.map((id) => Number(/^A-(\d+)$/.exec(id)?.[1] ?? 0));
  return `A-${Math.max(FIRST_NEW_ID - 1, ...numbers) + 1}`;
};

// Today's date in the recruiters' time zone, so an applicant added on a Friday evening in
// California is not stamped with Saturday's UTC date.
export const TIME_ZONE = 'America/Los_Angeles';
export const todayInTimeZone = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
