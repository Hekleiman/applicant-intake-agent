// In-memory interview calendar for local development.

export const SLOTS = ['Mon 10:00', 'Mon 14:00', 'Tue 11:00', 'Wed 09:30'] as const;

export type Slot = (typeof SLOTS)[number];

// Slot -> applicant ID. All slots start open.
export const bookings = new Map<Slot, string>();
