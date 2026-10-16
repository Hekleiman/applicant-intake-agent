// Run context passed to every run. RunState.toString() serializes this object as it is, so it
// holds plain data only: never a database client, a store object or a key. Tools get their data
// through storeFor(context) instead (src/data/storeFor.ts).
//
// sandboxId null: the CLI, backed by the in-memory store.
// sandboxId set: one live sandbox, backed by Supabase Postgres.

export type AppContext = { sandboxId: string | null };
