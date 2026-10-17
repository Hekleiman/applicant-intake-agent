// The interview calendar: the same four slots in the CLI and in every live sandbox.
// Who holds which slot lives in the store (src/data/store.ts).

export const SLOTS = ['Mon 10:00', 'Mon 14:00', 'Tue 11:00', 'Wed 09:30'] as const;

export type Slot = (typeof SLOTS)[number];

export const isSlot = (value: string): value is Slot => (SLOTS as readonly string[]).includes(value);

const DAYS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

// The plain label the board shows, for example "Mon 14:00" -> "Monday at 2:00 PM". Tools return
// it next to each slot so replies and the board use the same words.
export function slotLabel(slot: Slot): string {
  const [day = '', time = ''] = slot.split(' ');
  const [h = 0, m = 0] = time.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAYS[day] ?? day} at ${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export const withLabel = (slot: Slot) => ({ slot, label: slotLabel(slot) });
