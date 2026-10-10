-- Aria V2 — baseline schema (fresh project).
-- Replaces V1 migrations 001-010 (archived in docs/history/v1-migrations/).
-- Reference: docs/specs/2026-10-09-aria-v2-spec-and-architecture.md §5.
--
-- Identity is the messaging handle (no Supabase Auth). RLS is ON with NO
-- policies: anon/authenticated roles get nothing; all access is through the
-- service role in server routes (service role bypasses RLS).

create extension if not exists vector with schema extensions;  -- not in public (Supabase advisor)

-- ── People ──────────────────────────────────────────────────────────
create table users (
  id               uuid primary key default gen_random_uuid(),
  name             text,
  timezone         text not null default 'America/New_York',   -- IANA
  briefing_time    time not null default '08:00',
  next_briefing_at timestamptz,
  persona_prefs    jsonb not null default '{}'::jsonb,
  birth_year       int,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table signups (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  phone_e164      text,
  timezone        text,
  consent_version text,
  ip              inet,
  user_agent      text,
  matched_user_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours'
);

create table channels (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  kind            text not null check (kind in ('imessage','whatsapp','sms')),
  handle          text not null,           -- E.164, lowercased email, or wa_id
  handle_kind     text not null check (handle_kind in ('phone','email','bsuid')),
  provider        text,                    -- e.g. 'sendblue'
  provider_line   text,
  verified_at     timestamptz,
  is_primary      boolean not null default true,
  opted_out_at    timestamptz,
  paused_until    timestamptz,
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (kind, handle)
);
create index on channels (user_id);

create table consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  channel_id   uuid references channels(id) on delete set null,
  scope        text not null,              -- e.g. 'messaging'
  granted      boolean not null,
  copy_version text,
  captured_at  timestamptz not null default now(),
  source       text
);

-- ── Conversation ────────────────────────────────────────────────────
create table messages (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  channel_id          uuid not null references channels(id) on delete cascade,
  direction           text not null check (direction in ('in','out')),
  provider            text,
  provider_message_id text,
  body                text,
  media               jsonb,
  reply_to_message_id uuid references messages(id) on delete set null,
  status              text,
  consumed_by_run     uuid,
  created_at          timestamptz not null default now(),
  unique (provider, provider_message_id)    -- webhook retries are idempotent
);
create index on messages (user_id, created_at desc);

create table reactions (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  actor      text not null check (actor in ('user','aria')),
  type       text not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (message_id, actor, type)
);

create table conversation_summaries (
  user_id            uuid primary key references users(id) on delete cascade,
  through_message_id uuid references messages(id) on delete set null,
  summary            text,
  updated_at         timestamptz not null default now()
);

-- ── Runtime: per-user serialization + runs + cost log ───────────────
create table user_runtime (
  user_id     uuid primary key references users(id) on delete cascade,
  lease_until timestamptz,
  last_run_at timestamptz
);

create table agent_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  status      text not null default 'running',
  model       text,
  escalated   boolean not null default false,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  error       text
);

create table llm_calls (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references agent_runs(id) on delete set null,
  route         text,
  model         text,
  input_tokens  int,
  cache_read    int,
  cache_write   int,
  output_tokens int,
  cost_usd      numeric(10,6),
  latency_ms    int,
  created_at    timestamptz not null default now()
);

-- ── Jobs (scheduled/delayed work; ticked by Supabase Cron) ──────────
create table jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  user_id      uuid references users(id) on delete cascade,
  run_at       timestamptz not null default now(),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',   -- pending|running|done|dead
  attempts     int not null default 0,
  locked_until timestamptz,
  dedupe_key   text,
  last_error   text,
  created_at   timestamptz not null default now()
);
create index on jobs (run_at) where status = 'pending';
create unique index on jobs (dedupe_key) where status = 'pending' and dedupe_key is not null;

create table pending_actions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  kind               text not null,            -- e.g. 'send_email'
  payload            jsonb not null,
  preview_message_id uuid references messages(id) on delete set null,
  status             text not null default 'pending', -- pending|confirmed|cancelled|expired
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '24 hours'
);

create table reminders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  body           text not null,
  due_at         timestamptz,
  anchor_item_id uuid,                         -- a timeline_items id (offset-anchored)
  offset_minutes int,
  rrule          text,
  status         text not null default 'scheduled', -- scheduled|sent|cancelled
  job_id         uuid references jobs(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index on reminders (due_at) where status = 'scheduled';

-- ── Integrations ────────────────────────────────────────────────────
create table integrations (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  provider                text not null check (provider in ('google','canvas_ical')),
  account_email           text,
  scopes                  text[],
  enc_access_token        text,               -- AES-256-GCM, versioned (v1:...)
  enc_refresh_token       text,
  token_expires_at        timestamptz,
  status                  text not null default 'active',
  gmail_history_id        text,
  gmail_watch_expires_at  timestamptz,
  gcal_channel_id         text,
  gcal_channel_token_hash text,
  gcal_watch_expires_at   timestamptz,
  enc_ical_url            text,
  next_sync_at            timestamptz,
  synced_at               timestamptz,
  created_at              timestamptz not null default now(),
  unique (user_id, provider)
);

-- ── Academic timeline (replaces deadlines/canonical_events/calendar_events) ──
create table timeline_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  source      text not null check (source in ('canvas','gcal','gmail','syllabus','aria')),
  external_id text not null,
  kind        text not null check (kind in ('assignment','exam','event','class','block')),
  title       text,
  course      text,
  starts_at   timestamptz,
  ends_at     timestamptz,
  due_at      timestamptz,
  url         text,
  status      text not null default 'upcoming', -- upcoming|done|dismissed
  raw         jsonb,
  updated_at  timestamptz not null default now(),
  unique (user_id, source, external_id)         -- keyed by external id, not title+date
);
create index on timeline_items (user_id, due_at);

create table email_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  gmail_message_id text not null,
  thread_id        text,
  from_addr        text,
  subject          text,
  category         text,
  importance       text,
  summary          text,                        -- no raw bodies stored
  received_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (user_id, gmail_message_id)
);

create table syllabi (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  course_name text not null,
  parsed_json jsonb,
  parsed_at   timestamptz not null default now(),
  unique (user_id, course_name)
);

-- ── Memory ──────────────────────────────────────────────────────────
create table user_profile (
  user_id        uuid primary key references users(id) on delete cascade,
  school         text,
  courses        jsonb,
  class_times    jsonb,
  rendered_block text,                          -- <=400 tokens, injected every turn
  updated_at     timestamptz not null default now()
);

create table user_preferences (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  key                 text not null,
  category            text,
  statement           text not null,
  status              text not null default 'proposed', -- proposed|active|superseded|rejected
  source              text,                             -- confirmed|explicit|inferred
  valid_from          timestamptz not null default now(),
  valid_to            timestamptz,
  superseded_by       uuid references user_preferences(id) on delete set null,
  evidence_message_id uuid references messages(id) on delete set null,
  last_used_at        timestamptz
);
-- at most one active row per (user, key)
create unique index on user_preferences (user_id, key) where valid_to is null;

create table memory_facts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  content           text not null,
  tsv               tsvector generated always as (to_tsvector('english', content)) stored,
  embedding         extensions.vector(1024),              -- Phase 2; Phase 1 retrieval = FTS + recency
  source_message_id uuid references messages(id) on delete set null,
  confidence        real,
  expires_at        timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index on memory_facts using gin (tsv);
create index on memory_facts (user_id);

-- ── Web sessions + magic links ──────────────────────────────────────
create table magic_links (
  token_hash text primary key,                  -- sha256 of the token (never store raw)
  user_id    uuid not null references users(id) on delete cascade,
  purpose    text not null,                      -- view|setup|connect_google|email_draft|pwa_pair
  target     text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table web_sessions (
  session_hash text primary key,                 -- sha256 of the session id
  user_id      uuid not null references users(id) on delete cascade,
  scope        text not null default 'view',     -- view|full
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

-- ── RLS: enable on every table, define no policies (deny-all). ──────
-- The server uses the service-role key, which bypasses RLS.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
