import type { RunContext } from '@openai/agents';
import type { AppContext } from '../context.js';
import { memoryStore } from './memoryStore.js';
import type { Store } from './store.js';
import { SupabaseStore } from './supabaseStore.js';

// The store a run works on, chosen from the plain-data run context: the CLI's in-memory store
// when there is no sandbox, otherwise that sandbox's rows in Postgres.
export function storeFor(context: AppContext | RunContext<AppContext> | undefined): Store {
  const plain = context && 'context' in context ? context.context : context;
  const sandboxId = plain?.sandboxId ?? null;
  return sandboxId === null ? memoryStore : new SupabaseStore(sandboxId);
}
