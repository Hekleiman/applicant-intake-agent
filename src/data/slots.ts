// The interview calendar: the same four slots in the CLI and in every live sandbox.
// Who holds which slot lives in the store (src/data/store.ts).

export const SLOTS = ['Mon 10:00', 'Mon 14:00', 'Tue 11:00', 'Wed 09:30'] as const;

export type Slot = (typeof SLOTS)[number];

export const isSlot = (value: string): value is Slot => (SLOTS as readonly string[]).includes(value);
