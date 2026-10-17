import type { StoredScreening } from '../agents/screener.js';
import { isSlot, slotLabel } from '../data/slots.js';
import type { AuditEntry, Stage } from '../data/store.js';

// Plain sentences for the Activity panel, written on the server so the page and the smoke test
// read the same words.

export const STAGE_NAMES: Record<Stage, string> = {
  applied: 'Applied',
  phone_screen: 'Phone screen',
  interview_scheduled: 'Interview scheduled',
  offer: 'Offer',
  rejected: 'Rejected',
};

const FIT_WORDS: Record<StoredScreening['fit'], string> = {
  strong: 'strong fit',
  partial: 'partial fit',
  weak: 'weak fit',
  insufficient_info: 'not enough information',
};

// "The role was filled." -> "The role was filled", so a sentence around it gets one period.
export const trimReason = (reason: string): string => reason.trim().replace(/[\s.!?;:,]+$/, '');

const stageName = (stage: string | undefined) => (stage && stage in STAGE_NAMES ? STAGE_NAMES[stage as Stage] : stage ?? '');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The audit detail for a finished screening, for example "partial fit, 2 things to verify", with
// "(only the first part was screened)" when the resume was cut to 20,000 characters.
export function screenedDetail(s: StoredScreening): string {
  const detail = [
    FIT_WORDS[s.fit],
    plural(s.toVerify.length, 'thing to verify', 'things to verify'),
    ...(s.injectionAttempt ? ['flagged text aimed at an AI'] : []),
  ].join(', ');
  return s.truncated ? `${detail} (only the first part was screened)` : detail;
}

const isOffer = (detail: string) => /\boffer\b/.test(detail);

export function describeAudit(e: AuditEntry, nameOf: (id: string) => string): string {
  const who = nameOf(e.applicantId);
  const reason = trimReason(e.detail);
  switch (e.action) {
    case 'added':
      return `Added ${e.detail || who} to the board.`;
    case 'stage_changed': {
      const [from, to] = e.detail.split(' -> ');
      return `Moved ${who} from ${stageName(from)} to ${stageName(to)}.`;
    }
    case 'booked':
      return `Booked an interview for ${who}: ${isSlot(e.detail) ? slotLabel(e.detail) : e.detail}.`;
    case 'rejection_requested':
      return `The assistant asked to reject ${who}${reason ? ` (${reason})` : ''}.`;
    case 'offer_requested':
      return `The assistant asked to make ${who} an offer.`;
    case 'screened':
      return `Screened ${who}'s resume: ${reason}.`;
    case 'approved':
      return `A recruiter approved the ${isOffer(e.detail) ? 'offer for' : 'rejection of'} ${who}.`;
    case 'declined':
      return `A recruiter declined the ${isOffer(e.detail) ? 'offer for' : 'rejection of'} ${who}.`;
    case 'rejected':
      return `${who} is no longer being considered${reason ? ` (${reason})` : ''}.`;
    default:
      return `${e.action} ${who}`;
  }
}
