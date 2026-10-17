-- Applicant intake agent: live sandbox schema.
-- Every visitor gets a sandbox (a private copy of fake applicants). All rows hang off
-- sandboxes with ON DELETE CASCADE, so deleting a sandbox deletes everything in it.
-- Only the server touches these tables, with the secret key. RLS is on with no policies,
-- so the publishable (anon) key can read or write nothing.

create table public.sandboxes (
  id uuid primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.applicants (
  sandbox_id uuid not null references public.sandboxes (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 80),
  role text not null check (char_length(role) between 1 and 80),
  stage text not null check (stage in ('applied', 'phone_screen', 'interview_scheduled', 'offer', 'rejected')),
  applied_on date not null default current_date,
  notes text not null default '' check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  primary key (sandbox_id, id)
);

-- One applicant per slot and one slot per applicant, enforced by the database,
-- so two requests racing for the same slot can't both win.
create table public.bookings (
  sandbox_id uuid not null,
  slot text not null,
  applicant_id text not null,
  booked_at timestamptz not null default now(),
  primary key (sandbox_id, slot),
  unique (sandbox_id, applicant_id),
  foreign key (sandbox_id, applicant_id) references public.applicants (sandbox_id, id) on delete cascade
);

-- Conversation history for the SDK Session interface, in order.
create table public.session_items (
  sandbox_id uuid not null references public.sandboxes (id) on delete cascade,
  seq bigint generated always as identity,
  item jsonb not null,
  created_at timestamptz not null default now(),
  primary key (sandbox_id, seq)
);

-- A run paused for human approval. run_state is RunState.toString(). It stays on the
-- server because the SDK does not verify a restored state.
create table public.paused_runs (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references public.sandboxes (id) on delete cascade,
  interruptions jsonb not null,
  run_state text not null,
  status text not null default 'pending' check (status in ('pending', 'resolving', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  sandbox_id uuid not null references public.sandboxes (id) on delete cascade,
  at timestamptz not null default now(),
  applicant_id text not null,
  action text not null check (action in ('added', 'stage_changed', 'booked', 'rejection_requested', 'approved', 'declined', 'rejected')),
  detail text not null default ''
);

-- Rate limits and the daily budget read this. Kept 7 days; it outlives its sandbox.
create table public.usage_log (
  id bigint generated always as identity primary key,
  sandbox_id uuid references public.sandboxes (id) on delete set null,
  ip_hash text not null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('message', 'approval')),
  model_requests integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0
);

create index usage_log_ip_at on public.usage_log (ip_hash, at);
create index usage_log_at on public.usage_log (at);
create index sandboxes_last_seen on public.sandboxes (last_seen_at);
create index paused_runs_sandbox on public.paused_runs (sandbox_id, status);
create index audit_log_sandbox on public.audit_log (sandbox_id, at);

alter table public.sandboxes enable row level security;
alter table public.applicants enable row level security;
alter table public.bookings enable row level security;
alter table public.session_items enable row level security;
alter table public.paused_runs enable row level security;
alter table public.audit_log enable row level security;
alter table public.usage_log enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Hourly cleanup: sandboxes idle for 24 hours, usage rows older than 7 days.
create extension if not exists pg_cron;
select cron.schedule(
  'cleanup-sandboxes',
  '17 * * * *',
  $$delete from public.sandboxes where last_seen_at < now() - interval '24 hours';
    delete from public.usage_log where at < now() - interval '7 days';$$
);

-- 2026-10-16: resume screening. The extracted resume text (never the file), the Screener's
-- structured result and when it was last attempted; audit actions for screenings and offer
-- requests; usage rows for screenings.
alter table public.applicants
  add column resume_text text check (char_length(resume_text) <= 20000),
  add column screening jsonb,
  add column screened_at timestamptz;
alter table public.audit_log drop constraint audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check check (action in
  ('added', 'stage_changed', 'booked', 'rejection_requested', 'offer_requested', 'screened', 'approved', 'declined', 'rejected'));
alter table public.usage_log drop constraint usage_log_kind_check;
alter table public.usage_log add constraint usage_log_kind_check check (kind in ('message', 'approval', 'screening'));
