import { applicants as seedApplicants, type Applicant } from './applicants.js';
import { SLOTS, type Slot } from './slots.js';
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

// In-process store for the CLI: a copy of the seed data, reset on every start.
export class MemoryStore implements Store {
  private applicants: Applicant[] = seedApplicants.map((a) => ({ ...a }));
  // Slot -> applicant ID. All slots start open.
  private bookings = new Map<Slot, string>();
  private audit: AuditEntry[] = [];

  async findApplicants(query: string) {
    const q = query.trim().toLowerCase();
    return this.applicants
      .filter((a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q))
      .map((a) => ({ ...a }));
  }

  async getApplicant(id: string) {
    const found = this.applicants.find((a) => a.id === id.trim());
    return found ? { ...found } : null;
  }

  async listApplicants() {
    return this.applicants.map((a) => ({ ...a }));
  }

  async addApplicant(input: NewApplicant) {
    const applicant: Applicant = {
      id: nextApplicantId(this.applicants.map((a) => a.id)),
      name: input.name,
      role: input.role,
      stage: 'applied',
      appliedOn: todayInTimeZone(),
      notes: input.notes,
    };
    this.applicants.push(applicant);
    return { ...applicant };
  }

  async setStage(id: string, stage: Stage, from?: Stage[]) {
    const applicant = this.applicants.find((a) => a.id === id.trim());
    if (!applicant || (from && !from.includes(applicant.stage))) return false;
    applicant.stage = stage;
    return true;
  }

  async openSlots() {
    return SLOTS.filter((s) => !this.bookings.has(s));
  }

  async bookSlot(applicantId: string, slot: Slot): Promise<BookSlotResult> {
    const currentSlot = SLOTS.find((s) => this.bookings.get(s) === applicantId);
    if (currentSlot) return { ok: false, reason: 'already booked', currentSlot };
    if (this.bookings.has(slot)) return { ok: false, reason: 'slot taken' };
    this.bookings.set(slot, applicantId);
    return { ok: true };
  }

  async cancelBooking(applicantId: string) {
    for (const [slot, id] of this.bookings) if (id === applicantId) this.bookings.delete(slot);
  }

  async listBookings(): Promise<Booking[]> {
    return [...this.bookings].map(([slot, applicantId]) => ({ slot, applicantId }));
  }

  async addAudit(applicantId: string, action: AuditAction, detail: string) {
    this.audit.push({ at: new Date().toISOString(), applicantId, action, detail });
  }

  async listAudit(limit?: number) {
    return (limit === undefined ? this.audit : this.audit.slice(-limit)).map((e) => ({ ...e }));
  }

  // The CLI has no resume upload, so nobody has a screening.
  async getScreening(id: string): Promise<ScreeningRecord | null> {
    return (await this.getApplicant(id)) ? { hasResume: false, screening: null, screenedAt: null } : null;
  }
}

// The CLI's one store for the whole process.
export const memoryStore = new MemoryStore();
