import type { Applicant } from './applicants.js';
import type { Slot } from './slots.js';

export type Stage = Applicant['stage'];

export type AuditAction =
  | 'added'
  | 'stage_changed'
  | 'booked'
  | 'rejection_requested'
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

export type NewApplicant = { name: string; role: string; notes: string };

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
  listBookings(): Promise<Booking[]>;
  addAudit(applicantId: string, action: AuditAction, detail: string): Promise<void>;
  // Oldest first; with a limit, the newest `limit` entries.
  listAudit(limit?: number): Promise<AuditEntry[]>;
}

export const FIRST_NEW_ID = 1006;

export const nextApplicantId = (existing: string[]): string => {
  const numbers = existing.map((id) => Number(/^A-(\d+)$/.exec(id)?.[1] ?? 0));
  return `A-${Math.max(FIRST_NEW_ID - 1, ...numbers) + 1}`;
};
