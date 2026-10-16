# Applicant Intake Agent

## What it is

A small command-line recruiting assistant built on the OpenAI Agents SDK for TypeScript (`@openai/agents` 0.20.0) and `gpt-5.6-luna`. A recruiter chats with it to look up applicants, move them forward, book interview slots, make offers and reject applicants. Two agents share the work: an Intake agent that answers questions and routes, and a Scheduler agent that books interviews. Two input guardrails check every message: a code-only check stops messages that look like they contain a Social Security number (or are too long) before any model request is sent, and a small model-based topic check stops requests that have nothing to do with hiring before the main agent sees them. Rejecting an applicant or making an offer pauses the run until a human approves or declines. Every CLI run can be recorded to JSON and replayed in plain language on a static page in `docs/`, and a live sandbox lets a visitor use the same agents on their own private copy of the fake applicants.

Guided tour (recorded runs): https://applicant-intake-agent.vercel.app

Live sandbox (needs the access code from your link): https://applicant-intake-agent.vercel.app/live.html

## Architecture

```mermaid
flowchart TD
    U[User message] --> G{"Input guardrail<br/>pii_and_length<br/>(code only, blocking)"}
    U --> TC{"Input guardrail<br/>topic<br/>(one small model call, blocking)"}
    G -- blocked --> B["Canned reply<br/>0 model requests"]
    TC -- off_topic --> O["Fixed reply<br/>0 main-agent requests"]
    G -- pass --> I["Intake agent<br/>tools: lookup_applicant, reject_applicant, advance_stage"]
    TC -- pass --> I
    I -- "one-way handoff<br/>transfer_to_scheduler" --> S["Scheduler agent<br/>tools: lookup_applicant, book_interview, list_open_slots"]
    I -- "reject_applicant,<br/>advance_stage to offer" --> P{{"Approval pause<br/>RunState serialized to a string"}}
    P -- "human y / n" --> R["RunState restored, run resumed"]
    R --> I
    I --> A[Reply]
    S --> A

    subgraph Observability
        T["One trace per user message<br/>grouped by chat session (groupId)"]
        H["Runner lifecycle hooks<br/>agent_tool_start, agent_tool_end, agent_handoff"]
        J["docs/data/&lt;scenario&gt;.json<br/>replayed by docs/index.html"]
        H --> J
    end
    I -.-> T
    S -.-> T
    I -.-> H
    S -.-> H
```

Source layout:

| Path | Role |
| --- | --- |
| `src/index.ts` | CLI chat loop, its `Runner`, approval handling, tracing, usage reporting |
| `src/agents/` | Intake and Scheduler agents, the handoff wiring, optional reasoning effort, approval and guardrail reply wording |
| `src/tools/` | The five function tools; all business rules live here |
| `src/guardrails/piiGuardrail.ts` | The code-only input guardrail and `findPolicyViolation`, its shared rule |
| `src/guardrails/topicGuardrail.ts` | The model-based topic guardrail |
| `src/lib/runEvents.ts` | Lifecycle events from the Runner's hooks, collected per Runner (CLI) or per request (live) |
| `src/lib/recorder.ts` | CLI event recorder for the replay page |
| `src/lib/requestCounter.ts` | CLI only: counts Responses API calls at the HTTP layer |
| `src/data/` | Seed applicants and slots, the `Store` interface, `MemoryStore` (CLI) and `SupabaseStore` (live) |
| `src/memory/postgresSession.ts` | SDK `Session` backed by Postgres, one per sandbox |
| `src/server/` | Live API internals: passcode, limits, sandboxes, chat and approval runs |
| `api/` | Vercel functions: `sandbox`, `state`, `applicants`, `chat`, `approvals`, `reset` |
| `db/schema.sql` | The live database schema (documentation; already applied) |
| `docs/` | Static replay page (`index.html`), the four recordings and the live page (`live.html`) |
| `scripts/check-recordings.mjs` | Fails if a recording holds an SSN-shaped value |
| `scripts/smoke-live.mjs` | End-to-end test of the live API, including database checks |

## How it works

**Agent loop and turns.** Each user message is one call to `runner.run()`. Inside it the SDK loops: call the model, run any tool calls it asked for, feed the results back, and repeat until the model produces a final text answer or hands off to another agent. Each model call is one SDK turn; `maxTurns` is capped at 8 so a confused agent cannot loop forever.

**Session.** In the CLI a single `MemorySession` holds the conversation, so the agents remember earlier messages ("What stage is Sam in?" can follow a question about Maria). Each run appends its new items to the session.

**Triage routing.** Every user message starts at the Intake agent. When the message is about booking or availability, Intake calls `transfer_to_scheduler`, a one-way handoff, and the Scheduler finishes that run. The Scheduler has no handoff back. An earlier version had handoffs in both directions; the agents would sometimes pass a request back and forth (ping-pong) instead of answering it, burning model requests. With one-way handoffs and triage at the start of every message, there is no cycle to fall into. The Scheduler also has `lookup_applicant`, so it can answer a follow-up about an applicant without handing back.

**Business rules in tool code, not the prompt.** Tools read and write through a `Store` (`src/data/store.ts`), chosen per run by `storeFor(context)`: the in-memory store in the CLI, a sandbox's Postgres rows in the live site. `book_interview` refuses unknown applicants, rejected applicants, applicants who already hold a slot, and slots that are taken, and returns a structured reason (`{ booked: false, reason: 'slot taken', openSlots: [...] }`). The `slot` parameter is a Zod enum of the real slots. `list_open_slots` takes an `applicantId` and applies the same rule: for a rejected applicant it returns `{ error: 'applicant rejected', message: "... was rejected and can't be scheduled." }` and no slots, so the Scheduler has no times to offer. Before this, the Scheduler looked up Sam Chen (rejected) and still replied with open interview times, because the tool took no applicant and returned the slots to anyone. The prompt only tells the model to trust what the tool returns. A model can be talked out of an instruction; it cannot talk the tool out of an `if`.

**Two input guardrails, split by cost.** Both are attached to the Intake agent with `runInParallel: false`, so the main agent's first model request waits for both.

- `pii_and_length` (code check): a regex and a length check in `findPolicyViolation`. It is free, instant and makes no model call, and because it is plain code it cannot be argued with. When it trips, the app prints a canned reply and no request reaches any model.
- `topic` (topic check): one small classifier `Agent` on the same model, with a Zod `outputType` of `{ onTopic, reason }`. It reads only the newest user message, plus the previous assistant message when there is one, so a short answer like "Sam Rivera" to "Which Sam do you mean?" counts as on topic. On topic means applicants, their status, interviews and scheduling, rejections, the hiring process, or what the assistant can do. When it trips, the app replies "I can only help with applicants, interviews and hiring decisions." and the main agent makes no request. Its token usage is returned in `outputInfo` and added to the turn's usage.

They are split because the SDK starts all blocking guardrails at the same moment, not one after another: `runGuardrailsWithTripwire` in `node_modules/@openai/agents-core/dist/runner/guardrails.js` maps every guardrail to a promise (line 114) and awaits them with `Promise.all` (line 129), and `runInputGuardrailsForTurn` in `turnPreparation.js` (line 151) passes it the whole blocking list. So the topic check cannot rely on `pii_and_length` having stopped a message first. It calls `findPolicyViolation` itself and, when the code check would block the message, returns `tripwireTriggered: false` without calling a model. An SSN-shaped message is never sent to the classifier, and blocked messages cost 0 requests.

Blocked messages (either guardrail) are not saved to the session. The instruction "Politely decline requests unrelated to recruiting." stays in both agents' prompts as a second layer behind the topic check.

**Why the topic rule is enforced in code.** Before the topic guardrail, the only enforcement was that prompt sentence. Measured with the same input ("Write me a poem about the ocean", "Tell me a joke", "What's the capital of France?") run 5 times:

| | Declined | Complied | Main-agent requests for these messages |
| --- | --- | --- | --- |
| Prompt instruction only | 12 of 15 | 3 of 15 (one whole run wrote the poem, told the joke and answered "Paris") | 15 |
| With the topic guardrail | 15 of 15 blocked as `off_topic` | 0 of 15 | 0 |

Once the main agent complied with the first message in a run, it complied with the next two as well. With the guardrail, the off-topic text never enters the conversation history, so one slip cannot set a pattern.

**Human approval with serialized state.** `reject_applicant` has `needsApproval: true`, and `advance_stage` asks for approval only when the target is an offer (see the live sandbox section). When the model calls it, the run stops with an interruption instead of executing the tool. The app asks the human, calls `state.approve()` or `state.reject()` with a message telling the model not to retry ("A human recruiter declined this rejection." or "... this offer."), then serializes the paused run with `result.state.toString()`, restores it with `RunState.fromStringWithContext()`, and resumes with `runner.run(agent, restoredState)`. The round trip through a string is deliberate: it proves the pause could be stored in a database and resumed later by another process. Requests, decisions and executed changes go to the store's audit log, printed as `[audit]` lines when the CLI exits.

**SDK lifecycle hooks for the recorder.** The CLI uses one `Runner` instance for every run and resume. The recorder subscribes to the Runner's `agent_tool_start` and `agent_tool_end` events (keyed by `toolCall.callId` to measure duration) and to `agent_handoff`. Tools, the guardrail and the agents do not import the recorder at all. Guardrail results are read from `result.inputGuardrailResults`, or from the tripwire error's `.result` when blocked, and are placed on the timeline at the moment the run started. Recording is off unless `RECORD=<name>` is set.

**Tracing.** Each user message runs inside its own `withTrace('Recruiter chat turn')`, so the first run, any approval resumes and the guardrail outcome all land in one trace. Every trace in a chat session shares a `groupId`, so a whole conversation can be filtered together on the OpenAI traces dashboard. Traces are flushed before the process exits so piped runs are not lost.

## Live sandbox

`docs/live.html` is a live page for hiring managers to try. A visitor gets a private sandbox (a copy of the five fake applicants), can add applicants with a form, chat with the same agents, approve or decline rejections and offers, and watch an applicant board change. The guided tour on `index.html` stays as it was; it links to the live page and back.

**Architecture.** The page is plain static HTML, CSS and JavaScript served from `docs/`. It talks to six Vercel functions in `api/` (Node runtime, Web `Request` and `Response` handlers) in `pdx1`, next to the Supabase Postgres database in us-west-2. The functions call OpenAI with the same agents, tools and guardrails as the CLI. The OpenAI key and the Supabase secret key exist only in the functions' environment; the browser sees neither, and the database grants nothing to the publishable key (row level security on, no policies, no privileges for `anon` and `authenticated`).

```mermaid
flowchart LR
    B["live.html<br/>(static, in the browser)"] -- "x-demo-code header" --> F["Vercel functions in api/<br/>sandbox, state, applicants, chat, approvals, reset"]
    F --> O["OpenAI<br/>Intake, Scheduler, topic check"]
    F -- "secret key" --> D[("Supabase Postgres<br/>sandboxes, applicants, bookings,<br/>session_items, paused_runs, audit_log, usage_log")]
```

**Sandboxes.** `POST /api/sandbox` creates a sandbox with a server-generated UUID and seeds the five applicants; the browser keeps the ID in `localStorage`, so a reload continues the same sandbox, and "Start over" deletes it and creates a fresh one. Every row hangs off `sandboxes` with `on delete cascade`. A `pg_cron` job runs hourly and deletes sandboxes idle for 24 hours and usage rows older than 7 days. The schema is in `db/schema.sql`.

**Postgres Session.** `src/memory/postgresSession.ts` implements the SDK's `Session` interface (`getSessionId`, `getItems`, `addItems`, `popItem`, `clearSession`) against `session_items`, ordered by an identity column. `getSessionId()` returns the sandbox ID. That matters for approvals: when a paused run is resumed, the runner compares the session's ID with the session ID saved in the paused state (`dist/runner/sessionPersistence.js`, `!== pending.sessionId`). Each request builds a new `PostgresSession`, and because the ID is the sandbox ID rather than a random one, the approval request's session matches the one the chat request paused with.

**The run context holds only plain data.** `RunState.toString()` serializes the run context object itself (`dist/runContext.js`, the JSON with `context: this.context`). If the context held a database client, a store object or a key, it would be written into the stored run state. So `AppContext` is `{ sandboxId: string | null }` and nothing else. Tools get their data through `storeFor(context)`, and the Supabase client is a module-level singleton created from `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, imported only by server code. The smoke test checks that no stored run state contains `sb_secret`, `service_role` or `supabase.co`.

**Paused runs stay on the server.** When a run pauses, `RunState.toString()` and the interruptions (call ID, tool, parsed arguments, agent) go into `paused_runs`. The browser only ever receives the interruption details and the row ID, never `run_state`, because the SDK restores a state string as it is and does not verify it; a state that came back from the browser could have been edited. `POST /api/approvals` claims the row atomically (an update from `pending` to `resolving` filtered on `status = 'pending'`, so a double click or a second tab gets 409), requires a decision for every interruption, restores the state with `RunState.fromStringWithContext(startingAgent, runState, new RunContext({ sandboxId }))`, applies the decisions, resumes with the same Postgres session and marks the row resolved. If the resumed run pauses again, a new row is stored. While a sandbox has a pending approval, `POST /api/chat` returns 409: the paused tool call is in the session without a result, and a new run on top of it would fail.

**Booking rules in the database.** `bookings` has primary key `(sandbox_id, slot)` and `unique (sandbox_id, applicant_id)`. `SupabaseStore.bookSlot` simply inserts; a unique violation (Postgres error 23505) means "already booked" or "slot taken", and the tool returns the same result objects as the CLI. Two requests racing for the same slot cannot both win. Stage changes from `advance_stage` are compare-and-set updates filtered on the allowed current stages.

**advance_stage and conditional approval.** A new Intake tool, `advance_stage(applicantId, stage)`, moves an applicant to `phone_screen` (only from `applied`) or `offer` (only from `phone_screen` or `interview_scheduled`). Rejected applicants can't be moved; `interview_scheduled` is set only by booking and `rejected` only by `reject_applicant`. Its `needsApproval` is a function returning true only when the stage is `offer`, so "Move Priya to phone screen" just happens while "Make Maria Lopez an offer" waits for a human. The SDK evaluates the function again after a state is restored. Both moves are written to the audit log. Adding applicants is done only through the form (validated with Zod and checked with the same `findPolicyViolation` rule as the chat guardrail, so SSN-shaped input is refused with no model call); in chat the assistant points to the form.

**Per-request state.** Vercel's fluid compute runs several requests in one instance at once, so nothing request-specific lives at module level: each request gets its own `Runner`, event collector, session and store. Model requests and tokens come from `result.state.usage` plus the topic check's usage from its guardrail output, not from a global counter. The technical details under each reply list the guardrail results, tool calls with arguments and results, the handoff, approval events, and that turn's requests, tokens and cost.

**Passcode and limits.** Every endpoint requires an `x-demo-code` header equal to `DEMO_PASSCODE`, compared with `crypto.timingSafeEqual`. The page reads the code once from `?code=` in the link, keeps it in `localStorage` and removes it from the address bar. Before any model call, the chat and approval endpoints check `usage_log`: at most 40 chat or approval requests per IP per hour, 150 per sandbox in total, and 1,500 across the whole site per 24 hours; over a limit the answer is 429 with a plain message. The IP is stored only as a SHA-256 hash with a secret salt (`IP_HASH_SALT`). Every chat and approval request is logged before the model is called and updated with its model requests and tokens (topic check included) afterwards. A sandbox holds at most 25 applicants.

**Traces without sensitive data.** The live `Runner` (and the topic check's runner for live requests) sets `traceIncludeSensitiveData: false`, so traces on the OpenAI dashboard show the steps and timings of each turn but no message text, tool arguments or tool results. Each chat turn is one trace named "Live recruiter chat turn" and each approval one named "Live recruiter approval", grouped by sandbox ID. Traces are flushed with `waitUntil(getGlobalTraceProvider().forceFlush())` from `@vercel/functions`, so the export finishes after the response is sent instead of being frozen with the function.

**Errors.** Endpoints return JSON `{ error }` with a plain message. Details are logged on the server only; stack traces, keys and run state never reach the browser.

**Deployment notes.** `vercel.json` serves `docs/` as the static output, puts functions in `pdx1` and gives them 60 seconds. The repo type-checks with TypeScript 7, whose npm package no longer ships the JavaScript compiler API that Vercel's Node builder uses to compile `.ts` functions (`ts.sys` is undefined, and the build fails with "Cannot read properties of undefined (reading 'readFile')"). The production environment therefore sets `NPM_CONFIG_OMIT=dev`, so devDependencies (TypeScript 7, tsx) are not installed during the Vercel build and the builder falls back to its bundled TypeScript 5.9 to transpile the functions. Type checking stays local with `npm run typecheck`.

**Known limitations.**

- **No login.** Anyone with the link and code can create sandboxes; a sandbox ID in `localStorage` is the only thing tying a visitor to their sandbox.
- **One shared passcode.** Everyone uses the same code; rotating it means changing `DEMO_PASSCODE` and sending new links.
- **Rate limits by IP.** Visitors behind one network share a limit, and someone changing IPs gets a fresh hourly allowance (the per-sandbox and site-wide limits still apply).
- **No streaming.** Each reply arrives in one piece after the whole turn finishes, usually a few seconds.
- **Sandboxes are not real accounts.** They hold fictional data, are deleted after 24 hours without activity, and the chat history is not shown again after a reload (the assistant still remembers it).
- **Offer requests are not logged on their own.** The audit log's `action` check allows `rejection_requested` but no offer equivalent, so a requested offer shows up only when it is approved or declined.

## Measured results

All numbers below come from the four recordings in `docs/data/`, recorded in this commit with `RECORD=<name> npm start < test-inputs/<file>`, and from the console output of those same runs. Default reasoning effort, `gpt-5.6-luna`. Model output varies between runs, so treat token counts as one sample, not an average.

| Scenario (input file) | Turns | Model requests (main + topic check) | Input tokens | Cached input tokens | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| lookup (`lookup.txt`) | 5 | 12 (7 + 5) | 5,087 | 0 | 308 | about 0.14 cents |
| booking (`booking.txt`) | 4 | 18 (14 + 4) | 12,238 | 2,191 | 375 | about 0.25 cents |
| guardrail (`step4.txt`) | 6 | 8 (5 + 3) | 3,360 | 0 | 191 | about 0.09 cents |
| approval (`step5.txt`) | 3 | 11 (8 + 3) | 5,886 | 0 | 288 | about 0.15 cents |

The same totals split between the main agents and the topic check:

| Scenario | Main agents: requests, input, output tokens | Topic check: requests, input, output tokens | Topic check cost |
| --- | --- | --- | --- |
| lookup | 7, 4,222, 169 | 5, 865, 139 | about 0.03 cents |
| booking | 14, 11,561 (2,191 cached), 275 | 4, 677, 100 | about 0.03 cents |
| guardrail | 5, 2,843, 107 | 3, 517, 84 | about 0.02 cents |
| approval | 8, 5,380, 206 | 3, 506, 82 | about 0.02 cents |

How each was measured:

- **Model requests**: summed from the SDK's `result.state.usage.requests` over every part of each turn, including resumes after approval, plus the topic check's own `usage.requests` from its `outputInfo`. Cross-checked against a separate counter that wraps the OpenAI client's `fetch` and counts calls to `/responses`; the counter sees both the main agent and the classifier, and the two agreed on every turn of every scenario.
- **Input, cached and output tokens**: summed from the SDK usage (`inputTokens`, `cached_tokens` in `inputTokensDetails`, `outputTokens`) over every part of each turn, topic check included. The only cache hit was the fourth booking turn (2,191 of 4,565 input tokens cached).
- **What the topic check adds per message**: one model request for every message that passes the code check, 154 to 187 input tokens and 23 to 33 output tokens in these recordings (about 171 and 27 on average), which is about 0.007 cents per message. It adds nothing for messages the code check blocks.
- **Cost**: uncached input at $0.20, cached input at $0.02 and output at $1.20 per million tokens, computed by the replay page from the recorded token counts.
- **Guardrail blocks with 0 model requests**: in the guardrail scenario, the three messages the code check blocked (two SSN-shaped, one over 2,000 characters) each recorded 0 requests and 0 tokens for both the main agent and the topic check, and the HTTP counter printed `model requests this turn=0` for each. The session item count did not change on those turns (stayed at 4, 8 and 8), so blocked text never entered the conversation history. "Call me at 760-555-0123 about Maria" passed both checks.
- **Off-topic block**: in the lookup scenario, "Write me a poem about the ocean" made 1 request (the topic check, 182 input and 33 output tokens) and 0 main-agent requests, and the session stayed at 12 items.
- **State size at the approval pause**: the serialized `RunState` was 23,262 bytes for the first rejection (approved) and 25,015 bytes for the second (declined), measured with `Buffer.byteLength(result.state.toString())` just before restoring.
- **Requests per approval turn**: 4 model requests for each rejection turn (the topic check, lookup, the paused `reject_applicant` call, and the reply after resume), from the HTTP counter.
- **Repeated runs before recording** (without `RECORD`): the off-topic input 5 times (15 of 15 blocked, 0 main-agent requests), `lookup.txt` 3 times (poem blocked every time, "Sam Rivera", "What can you help me with?" and the hiring questions passed every time), and `booking.txt` 3 times (turn 2 said Sam Chen was rejected and listed no times every time).

## Run it

Requires Node 22 or newer and an OpenAI API key. The CLI needs nothing else; the live sandbox also needs the Supabase and passcode variables in `.env.example`.

```bash
cp .env.example .env
```

Put your key in `.env`, then:

```bash
npm install
```

```bash
npm start
```

That starts an interactive chat (type `exit` to quit). The four demo scenarios pipe a file of messages instead:

```bash
npm start < test-inputs/lookup.txt
```

```bash
npm start < test-inputs/booking.txt
```

```bash
npm start < test-inputs/step4.txt
```

```bash
npm start < test-inputs/step5.txt
```

To re-record a scenario for the replay page, set `RECORD` to its name (`lookup`, `booking`, `guardrail` or `approval`), which writes `docs/data/<name>.json`:

```bash
RECORD=guardrail npm start < test-inputs/step4.txt
```

Check that no recording contains an SSN-shaped value:

```bash
npm run check:recordings
```

Type-check:

```bash
npm run typecheck
```

Run the live sandbox locally with `vercel dev` (it serves `docs/` and the functions in `api/`), then run the end-to-end test against it. It makes real model calls, uses `DEMO_PASSCODE`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `.env`, and deletes its sandboxes when done:

```bash
node --env-file=.env scripts/smoke-live.mjs http://localhost:3000
```

Because of the TypeScript 7 note above, `vercel dev` and `vercel build` need a checkout without devDependencies installed (for example a copy with `npm ci --omit=dev`).

To view only the replay page, serve `docs/` with any static file server (it loads the JSON with `fetch`, so opening the file directly will not work):

```bash
python3 -m http.server 8000 --directory docs
```

## Known limitations

- **The CLI is in-memory.** In the CLI, applicants, bookings, the audit log and the chat session live in process memory and are reset on every start, and the serialized approval state is only round-tripped in memory. The live sandbox stores all of these in Postgres (see above).
- **The topic check is a model call.** It can misjudge a message in either direction, it adds one request and some latency to every message that passes the code check, and a message written to argue with the classifier could talk it into a pass. The prompt instruction behind it is the second layer.
- **Regex-only PII check.** The guardrail recognises SSN-shaped digit runs and overlong messages. It does not detect names, addresses, emails, other ID formats or SSNs written out in words, and it can block harmless nine-digit numbers.
- **The CLI is single process, single user.** One chat loop on stdin. The live sandbox runs on a server with per-sandbox data, but it has no real accounts (see its limitations above).
- **The guided tour shows recordings, not live calls.** `index.html` replays the JSON in `docs/data/`; nothing on that page calls a model. The live page does.
- **Sensitive data in CLI traces.** In the CLI, `traceIncludeSensitiveData` is left at its default, so traces uploaded to OpenAI contain message text and tool inputs and outputs. The live sandbox turns it off.
- **Guardrails only on the first agent.** Input guardrails run on the run's first agent. That covers all input today because every message starts at Intake; a routing change that starts runs at the Scheduler would need both guardrails added there.
- **Name matching is a substring match.** "Sam" matches both Sam Rivera and Sam Chen and the agent has to ask; there is no fuzzy matching.
- **Small, single-sample measurements.** The numbers above come from one recording per scenario, not repeated runs, and model behaviour varies between runs.
