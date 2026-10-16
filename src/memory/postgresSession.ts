import type { AgentInputItem, Session } from '@openai/agents';
import { check, db } from '../server/supabase.js';

const PAGE = 1000;

// Conversation history for one live sandbox, stored in session_items in insertion order (seq).
//
// getSessionId() returns the sandbox ID. When a paused run is resumed, the runner checks that the
// session's ID equals the one saved in the paused state, so every request can build a new
// PostgresSession for the same sandbox and still resume a run paused by an earlier request.
export class PostgresSession implements Session {
  constructor(private readonly sandboxId: string) {}

  async getSessionId() {
    return this.sandboxId;
  }

  // The newest `limit` items in chronological order, or all items when no limit is given.
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit !== undefined) {
      if (limit <= 0) return [];
      const rows = check(
        await db()
          .from('session_items')
          .select('item')
          .eq('sandbox_id', this.sandboxId)
          .order('seq', { ascending: false })
          .limit(limit),
        'get session items',
      ) as { item: AgentInputItem }[];
      return rows.reverse().map((r) => r.item);
    }

    // PostgREST caps a response at 1,000 rows, so read the whole history in pages.
    const items: AgentInputItem[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = check(
        await db()
          .from('session_items')
          .select('item')
          .eq('sandbox_id', this.sandboxId)
          .order('seq', { ascending: true })
          .range(from, from + PAGE - 1),
        'get session items',
      ) as { item: AgentInputItem }[];
      items.push(...rows.map((r) => r.item));
      if (rows.length < PAGE) return items;
    }
  }

  // One insert, so the rows get consecutive seq values in the order given.
  async addItems(items: AgentInputItem[]) {
    if (items.length === 0) return;
    check(
      await db()
        .from('session_items')
        .insert(items.map((item) => ({ sandbox_id: this.sandboxId, item }))),
      'add session items',
    );
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const newest = check(
      await db()
        .from('session_items')
        .select('seq, item')
        .eq('sandbox_id', this.sandboxId)
        .order('seq', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'pop session item',
    ) as { seq: number; item: AgentInputItem } | null;
    if (!newest) return undefined;
    check(
      await db().from('session_items').delete().eq('sandbox_id', this.sandboxId).eq('seq', newest.seq),
      'pop session item',
    );
    return newest.item;
  }

  async clearSession() {
    check(await db().from('session_items').delete().eq('sandbox_id', this.sandboxId), 'clear session');
  }
}
