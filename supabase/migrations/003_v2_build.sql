-- Aria V2 — consolidated build migration (applies on top of 001 + 002).
-- Source of truth for decisions: docs/plans/2026-10-10-v2-master-plan.md (§2 conflict log).
--
-- Sections and the branch plan each came from:
--   §0  extensions + private schema ............ V2-03 §4
--   §1  users ................................... V2-03 §4, V2-06 §4, web §4 (quiet_* names from V2-03/web)
--   §2  channels, messages ...................... V2-03 §4
--   §3  agent_runs, llm_calls ................... V2-04 §4 (+ V2-08 §4 job_id/meta)
--   §4  jobs, user_runtime, proactive_dedupe .... V2-03 §4 (+ V2-04 memory cursor)
--   §5  pending_actions ......................... V2-04 §4 + web §4 (merged lifecycle)
--   §6  user_preferences, memory_facts .......... V2-04 §4 (+ V2-07 §4.3 constraint_json)
--   §7  timeline_items .......................... V2-05 §4
--   §8  reminders, briefings, briefing_notes,
--       system_heartbeat ........................ V2-06 §4
--   §9  integrations, email_items ............... V2-05 §4 + V2-07 §4 (merged, one status check)
--   §10 syllabi ................................. V2-08 §4
--   §11 web_sessions, magic_links, signups ...... web §4
--   §12 functions (security definer, search_path '', service_role only)
--   §13 grants
--   §14 pg_cron (all safe before deploy: the dispatch tick is a no-op until Vault secrets exist)
--   §15 RLS sweep (deny-all; service role bypasses)
--
-- Idempotent where cheap: IF NOT EXISTS on columns/indexes/tables, drop-then-add for
-- constraints, CREATE OR REPLACE for functions, cron.schedule upserts by name.

-- ═══ §0 Extensions + private schema ══════════════════════════════════════
create extension if not exists pgcrypto with schema extensions;   -- hmac() for the jobs tick
create schema if not exists private;                              -- not exposed by PostgREST
revoke all on schema private from public, anon, authenticated;

-- ═══ §1 users ═════════════════════════════════════════════════════════════
alter table public.users
  add column if not exists quiet_start            time        not null default '22:00',
  add column if not exists quiet_end              time        not null default '08:00',
  add column if not exists timezone_source        text        not null default 'default',
  add column if not exists briefing_enabled       boolean     not null default true,
  add column if not exists deadline_nudge_minutes int[]       not null default '{180}',
  add column if not exists last_briefing_sent_at  timestamptz;
alter table public.users
  drop constraint if exists users_timezone_source_chk,
  add  constraint users_timezone_source_chk
       check (timezone_source in ('default','signup','user','inferred')),
  drop constraint if exists users_nudge_minutes_card,
  add  constraint users_nudge_minutes_card check (cardinality(deadline_nudge_minutes) <= 3);

-- ═══ §2 channels + messages ═══════════════════════════════════════════════
-- All Sendblue handles are kind='imessage'; per-message transport lives in `service`.
alter table public.channels
  add column if not exists last_service text;
alter table public.channels
  drop constraint if exists channels_last_service_chk,
  add  constraint channels_last_service_chk check (last_service in ('imessage','sms','rcs'));

alter table public.messages
  add column if not exists run_id          uuid references public.agent_runs(id) on delete set null,
  add column if not exists delivery_id     uuid,
  add column if not exists proactive_class text,
  add column if not exists trigger         text,      -- reply|interim|welcome|contact_card|command|fallback|<proactive reason>
  add column if not exists idempotency_key text,      -- '<runId>:<i>', '<jobId>:<i>', 'welcome:<channelId>:<i>', '<dedupeKey>:<i>'
  add column if not exists service         text,
  add column if not exists outside_window  boolean not null default false;
alter table public.messages
  drop constraint if exists messages_proactive_class_chk,
  add  constraint messages_proactive_class_chk check (proactive_class in ('routine','urgent','requested')),
  drop constraint if exists messages_service_chk,
  add  constraint messages_service_chk check (service in ('imessage','sms','rcs'));
create unique index if not exists messages_idempotency_key_uidx
  on public.messages (idempotency_key) where idempotency_key is not null;
create index if not exists messages_unconsumed_idx
  on public.messages (user_id, created_at) where direction = 'in' and consumed_by_run is null;
create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists messages_proactive_idx
  on public.messages (user_id, created_at) where proactive_class is not null;
create index if not exists messages_run_idx on public.messages (run_id) where run_id is not null;

-- ═══ §3 agent_runs + llm_calls ════════════════════════════════════════════
-- The pipeline (V2-03) creates the run row; the agent (V2-04) fills the stats columns.
alter table public.agent_runs
  add column if not exists trigger           text    not null default 'inbound',
  add column if not exists is_eval           boolean not null default false,
  add column if not exists channel_id        uuid references public.channels(id) on delete set null,
  add column if not exists input_message_ids uuid[]  not null default '{}',
  add column if not exists iterations        int     not null default 0,
  add column if not exists llm_call_count    int     not null default 0,
  add column if not exists tool_calls        jsonb   not null default '[]'::jsonb,  -- [{name, ok, ms, err?}] — never arg bodies
  add column if not exists escalation_reason text,
  add column if not exists cost_usd          numeric(10,6) not null default 0,
  add column if not exists latency_ms        int,
  add column if not exists plan              jsonb;                                  -- resolved ReplyPlan (ids, not aliases)
alter table public.agent_runs
  drop constraint if exists agent_runs_status_chk,
  add  constraint agent_runs_status_chk check (status in ('running','done','failed','aborted')),
  drop constraint if exists agent_runs_trigger_chk,
  add  constraint agent_runs_trigger_chk check (trigger in ('inbound','proactive','command','welcome'));
create index if not exists agent_runs_started_idx      on public.agent_runs (started_at desc);
create index if not exists agent_runs_user_started_idx on public.agent_runs (user_id, started_at desc);

alter table public.llm_calls
  add column if not exists user_id         uuid references public.users(id) on delete set null,
  add column if not exists job_id          uuid references public.jobs(id)  on delete set null,
  add column if not exists provider        text not null default 'anthropic',
  add column if not exists iteration       int,
  add column if not exists stop_reason     text,
  add column if not exists thinking_tokens int,
  add column if not exists error           text,
  add column if not exists request_id      text,
  add column if not exists meta            jsonb;      -- {attempt, outcome, parser_request_id, ...}; never content
create index if not exists llm_calls_created_idx      on public.llm_calls (created_at desc);
create index if not exists llm_calls_run_idx          on public.llm_calls (run_id);
create index if not exists llm_calls_user_created_idx on public.llm_calls (user_id, created_at desc);

-- ═══ §4 jobs + user_runtime + proactive_dedupe ════════════════════════════
alter table public.jobs
  add column if not exists locked_by    uuid,
  add column if not exists max_attempts int not null default 5,
  add column if not exists started_at   timestamptz,
  add column if not exists finished_at  timestamptz;
alter table public.jobs
  drop constraint if exists jobs_status_chk,
  add  constraint jobs_status_chk check (status in ('pending','running','done','dead'));
create index if not exists jobs_running_lock_idx on public.jobs (locked_until) where status = 'running';
create index if not exists jobs_finished_idx     on public.jobs (finished_at)  where status in ('done','dead');
create index if not exists jobs_user_kind_idx    on public.jobs (user_id, kind) where status in ('pending','running');
-- canvas-sync-enqueue's NOT EXISTS probes dedupe_key across pending AND running rows; the
-- baseline unique index covers pending only, so running rows would otherwise seq-scan jobs.
create index if not exists jobs_dedupe_active_idx
  on public.jobs (dedupe_key) where status in ('pending','running') and dedupe_key is not null;

alter table public.user_runtime
  add column if not exists lease_owner              uuid,          -- DB-fallback lease owner token
  add column if not exists memory_extracted_through timestamptz;   -- memory_extract cursor

-- At-most-once for proactive producer items (reminders, briefings, alerts).
create table if not exists public.proactive_dedupe (
  user_id      uuid not null references public.users(id) on delete cascade,
  dedupe_key   text not null,
  delivered_at timestamptz not null default now(),
  primary key (user_id, dedupe_key)
);

-- ═══ §5 pending_actions (one lifecycle for chat + web) ════════════════════
-- pending → executing → done | failed ; pending → cancelled | expired
alter table public.pending_actions
  add column if not exists run_id      uuid references public.agent_runs(id) on delete set null, -- creating run (chat)
  add column if not exists summary     text,          -- one-line preview for context (untrusted parts pre-wrapped)
  add column if not exists version     int         not null default 1,   -- optimistic concurrency (web edit vs chat revise)
  add column if not exists updated_at  timestamptz not null default now(),
  add column if not exists decided_at  timestamptz,   -- confirm or cancel time
  add column if not exists decided_via text,
  add column if not exists executed_at timestamptz,
  add column if not exists result      jsonb,         -- e.g. {"gmail_message_id": "...", "sent_at": "..."}; no bodies
  add column if not exists error       text;
alter table public.pending_actions
  drop constraint if exists pending_actions_status_chk,
  add  constraint pending_actions_status_chk
       check (status in ('pending','executing','done','failed','cancelled','expired')),
  drop constraint if exists pending_actions_decided_via_chk,
  add  constraint pending_actions_decided_via_chk check (decided_via in ('chat','web','expiry'));
create index if not exists pending_actions_user_status_idx on public.pending_actions (user_id, status);

-- ═══ §6 user_preferences + memory_facts ═══════════════════════════════════
-- Baseline index `(user_id, key) WHERE valid_to IS NULL` collides a proposed replacement
-- with the active row. Drop it by predicate (auto-generated name not relied upon).
do $$
declare r record;
begin
  for r in select indexname from pg_indexes
            where schemaname = 'public' and tablename = 'user_preferences'
              and indexdef ilike '%(user_id, key)%' and indexdef ilike '%valid_to IS NULL%'
  loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;

alter table public.user_preferences
  add column if not exists asked_at        timestamptz,
  add column if not exists decided_at      timestamptz,
  add column if not exists proposed_by_run uuid references public.agent_runs(id) on delete set null,
  add column if not exists constraint_json jsonb;   -- machine-readable scheduling constraint (src/shared/scheduling-constraints.ts)
alter table public.user_preferences
  drop constraint if exists user_preferences_status_chk,
  add  constraint user_preferences_status_chk
       check (status in ('proposed','queued','active','superseded','rejected','expired')),
  drop constraint if exists user_preferences_source_chk,
  add  constraint user_preferences_source_chk
       check (source is null or source in ('confirmed','explicit','inferred')),
  drop constraint if exists user_preferences_key_chk,
  add  constraint user_preferences_key_chk check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$'),
  drop constraint if exists user_preferences_open_iff_unclosed_chk,
  add  constraint user_preferences_open_iff_unclosed_chk
       check ((status in ('proposed','queued','active')) = (valid_to is null));
create unique index if not exists user_preferences_one_active_per_key
  on public.user_preferences (user_id, key) where status = 'active';
create unique index if not exists user_preferences_one_open_question
  on public.user_preferences (user_id) where status = 'proposed';
create index if not exists user_preferences_user_status_idx on public.user_preferences (user_id, status);

alter table public.memory_facts
  add column if not exists category         text,
  add column if not exists source           text not null default 'extraction',
  add column if not exists updated_at       timestamptz not null default now(),
  add column if not exists superseded_by    uuid references public.memory_facts(id) on delete set null,
  add column if not exists last_recalled_at timestamptz;
alter table public.memory_facts
  drop constraint if exists memory_facts_category_chk,
  add  constraint memory_facts_category_chk check (category is null or category in
       ('people','academics','career','schedule','life','other')),
  drop constraint if exists memory_facts_source_chk,
  add  constraint memory_facts_source_chk check (source in ('extraction','explicit','user_edit'));
create index if not exists memory_facts_user_live_idx
  on public.memory_facts (user_id, created_at desc) where deleted_at is null;

-- ═══ §7 timeline_items ════════════════════════════════════════════════════
alter table public.timeline_items
  add column if not exists all_day    boolean not null default false,
  add column if not exists timing_key text,          -- source literal; a change ⇒ due_changed
  add column if not exists match_key  text,          -- Canvas object key (rekey on override UID swap)
  add column if not exists removed_at timestamptz,   -- soft removal; hidden from all reads
  add column if not exists anchor_at  timestamptz generated always as (coalesce(due_at, starts_at)) stored;
alter table public.timeline_items
  drop constraint if exists timeline_items_status_check,
  add  constraint timeline_items_status_check check (status in ('upcoming','done','dismissed'));
create index if not exists timeline_items_user_anchor_idx
  on public.timeline_items (user_id, anchor_at) where removed_at is null;
create index if not exists timeline_items_user_match_idx
  on public.timeline_items (user_id, source, match_key) where match_key is not null;

-- ═══ §8 reminders, briefings, briefing_notes, system_heartbeat ═════════════
alter table public.reminders
  add column if not exists kind          text not null default 'absolute',
  add column if not exists origin        text not null default 'user',
  add column if not exists last_fired_at timestamptz,
  add column if not exists fire_count    int  not null default 0,
  add column if not exists updated_at    timestamptz not null default now();
alter table public.reminders
  drop constraint if exists reminders_kind_chk,
  add  constraint reminders_kind_chk   check (kind in ('absolute','anchored','recurring')),
  drop constraint if exists reminders_origin_chk,
  add  constraint reminders_origin_chk check (origin in ('user','auto')),
  drop constraint if exists reminders_status_chk,
  add  constraint reminders_status_chk check (status in ('scheduled','sent','cancelled','expired')),
  drop constraint if exists reminders_shape_chk,
  add  constraint reminders_shape_chk check (
       (kind = 'absolute'  and anchor_item_id is null and offset_minutes is null and rrule is null)
    or (kind = 'anchored'  and offset_minutes is not null and rrule is null)
    or (kind = 'recurring' and rrule is not null and anchor_item_id is null)),
  drop constraint if exists reminders_anchor_fk,
  add  constraint reminders_anchor_fk
       foreign key (anchor_item_id) references public.timeline_items(id) on delete set null;
create unique index if not exists reminders_auto_nudge_uniq
  on public.reminders (anchor_item_id, offset_minutes)
  where origin = 'auto' and anchor_item_id is not null;
create index if not exists reminders_anchor_idx      on public.reminders (anchor_item_id) where anchor_item_id is not null;
create index if not exists reminders_user_status_idx on public.reminders (user_id, status);

create table if not exists public.briefings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  local_date    date not null,                       -- in users.timezone at prepare time
  kind          text not null default 'daily'
                  check (kind in ('daily','monday','catchup','connect_nudge','empty')),
  status        text not null default 'preparing'
                  check (status in ('preparing','ready','sent','deferred','skipped','failed')),
  target_at     timestamptz not null,
  snapshot_hash text,
  plan          jsonb,                                -- bubbles; purged after 180 days by retention_purge
  skip_reason   text,
  llm_cost_usd  numeric(10,6),
  generated_at  timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, local_date)
);
create index if not exists briefings_user_kind_idx on public.briefings (user_id, kind);

create table if not exists public.briefing_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  kind        text not null check (kind in
                ('due_changed','item_removed','reminder_cancelled','reminder_expired',
                 'alert_expired','preference_proposal','other')),
  item_id     uuid references public.timeline_items(id) on delete cascade,
  payload     jsonb not null default '{}'::jsonb,     -- {title, course, oldDue, newDue}; never email bodies
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by uuid references public.briefings(id) on delete set null
);
create unique index if not exists briefing_notes_dedupe
  on public.briefing_notes (user_id, dedupe_key) where consumed_at is null and dedupe_key is not null;
create index if not exists briefing_notes_open_idx on public.briefing_notes (user_id) where consumed_at is null;

create table if not exists public.system_heartbeat (
  id      text primary key,                          -- 'daily-cron' | 'gh-actions'
  beat_at timestamptz not null default now(),
  detail  jsonb
);

-- ═══ §9 integrations + email_items ════════════════════════════════════════
alter table public.integrations
  -- Canvas (V2-05)
  add column if not exists ical_host             text,          -- 'yale.instructure.com' (not secret)
  add column if not exists ical_url_fp           text,          -- HMAC-SHA256(hkdf(APP_ENCRYPTION_KEY), normalized url), hex
  add column if not exists sync_lease_until      timestamptz,
  add column if not exists consecutive_failures  int not null default 0,
  add column if not exists first_failure_at      timestamptz,
  add column if not exists last_error            text,          -- last sync error CODE only
  add column if not exists last_error_at         timestamptz,
  add column if not exists feed_hash             text,          -- sha256(body || tz)
  -- Google (V2-07)
  add column if not exists gcal_resource_id      text,
  add column if not exists gcal_aria_calendar_id text,
  add column if not exists gcal_calendar_ids     text[] not null default '{}',
  add column if not exists gmail_synced_at       timestamptz,
  add column if not exists gmail_triage          jsonb,         -- {run_id, started_at, total, fetched, candidates, progress_sent_at, completed_at}
  add column if not exists connected_at          timestamptz,
  -- shared (both providers)
  add column if not exists status_reason         text,          -- why status changed: invalid_grant | admin_blocked | feed_not_found | user_disconnected | ...
  add column if not exists status_notified_at    timestamptz;   -- one-time "integration broke" message claim
alter table public.integrations
  drop constraint if exists integrations_status_check,
  add  constraint integrations_status_check check (status in ('active','error','revoked','disconnected'));
create unique index if not exists integrations_ical_url_fp_key
  on public.integrations (ical_url_fp) where provider = 'canvas_ical' and ical_url_fp is not null;
create index if not exists integrations_canvas_next_sync_idx
  on public.integrations (next_sync_at) where provider = 'canvas_ical' and status in ('active','error');
create unique index if not exists integrations_google_account_uidx
  on public.integrations (lower(account_email)) where provider = 'google' and status <> 'disconnected';
create unique index if not exists integrations_gcal_channel_uidx
  on public.integrations (gcal_channel_id) where gcal_channel_id is not null;

alter table public.email_items
  add column if not exists rfc822_message_id text,
  add column if not exists kind              text,
  add column if not exists course            text,
  add column if not exists old_due           timestamptz,
  add column if not exists new_due           timestamptz,
  add column if not exists confidence        real,
  add column if not exists labels            text[],
  add column if not exists prefilter_reason  text,
  add column if not exists source            text not null default 'push',
  add column if not exists classified_at     timestamptz,
  add column if not exists alerted_at        timestamptz,     -- atomic alert claim
  add column if not exists surfaced_at       timestamptz;     -- included in a briefing/digest
alter table public.email_items
  drop constraint if exists email_items_kind_check,
  add  constraint email_items_kind_check
       check (kind is null or kind in ('deadline_change','interview','action_needed','fyi')),
  drop constraint if exists email_items_importance_check,
  add  constraint email_items_importance_check
       check (importance is null or importance in ('high','medium','low','skipped')),
  drop constraint if exists email_items_source_check,
  add  constraint email_items_source_check check (source in ('push','triage','resync'));
create index if not exists email_items_user_received_idx on public.email_items (user_id, received_at desc);
create index if not exists email_items_unsurfaced_idx
  on public.email_items (user_id) where importance in ('high','medium') and surfaced_at is null;
create index if not exists email_items_unclassified_idx
  on public.email_items (user_id, created_at) where classified_at is null and importance is null;

-- ═══ §10 syllabi ══════════════════════════════════════════════════════════
alter table public.syllabi
  add column if not exists course_key        text,
  add column if not exists course_code       text,
  add column if not exists term              text,
  add column if not exists status            text not null default 'parsed',
  add column if not exists source            text,
  add column if not exists source_message_id uuid references public.messages(id) on delete set null,
  add column if not exists pdf_sha256        text,
  add column if not exists page_count        int,
  add column if not exists model             text,
  add column if not exists parser_version    text,
  add column if not exists issues            jsonb not null default '[]'::jsonb,
  add column if not exists updated_at        timestamptz not null default now();
alter table public.syllabi
  drop constraint if exists syllabi_status_chk,
  add  constraint syllabi_status_chk check (status in ('parsed','needs_review')),
  drop constraint if exists syllabi_source_chk,
  add  constraint syllabi_source_chk check (source in ('imessage','upload','dev'));
-- Table has no writer yet; backfill defensively so NOT NULL can't fail.
update public.syllabi
   set course_key = upper(regexp_replace(course_name, '[^A-Za-z0-9]', '', 'g'))
 where course_key is null;
update public.syllabi set parsed_json = '{}'::jsonb where parsed_json is null;
alter table public.syllabi alter column course_key  set not null;
alter table public.syllabi alter column parsed_json set not null;
alter table public.syllabi drop constraint if exists syllabi_user_id_course_name_key;
create unique index if not exists syllabi_user_course_key_uidx on public.syllabi (user_id, course_key);
create index if not exists syllabi_user_sha_idx on public.syllabi (user_id, pdf_sha256);

-- ═══ §11 web_sessions, magic_links, signups ═══════════════════════════════
alter table public.web_sessions
  drop constraint if exists web_sessions_scope_check,
  add  constraint web_sessions_scope_check check (scope in ('view','setup'));
create index if not exists web_sessions_user_live_idx on public.web_sessions (user_id) where revoked_at is null;
create index if not exists magic_links_user_created_idx on public.magic_links (user_id, created_at);
create index if not exists signups_phone_idx        on public.signups (phone_e164);
create index if not exists signups_matched_user_idx on public.signups (matched_user_id);

-- ═══ §12 Functions ════════════════════════════════════════════════════════
-- All: security definer, search_path = '' (every object schema-qualified; pg_catalog is
-- always searched implicitly). Execute is revoked from public/anon/authenticated in §13.

-- enqueue_job: upsert on the PARTIAL unique index jobs(dedupe_key) where pending (supabase-js can't).
-- Modes: keep | replace (latest wins; run_at may move earlier) | debounce (capped push) | append (payload.items concat).
create or replace function public.enqueue_job(
  p_kind text,
  p_user_id uuid default null,
  p_run_at timestamptz default null,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_mode text default 'replace',
  p_max_delay_ms int default null,
  p_max_attempts int default 5)
returns table (job_id uuid, job_run_at timestamptz, db_now timestamptz, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_run_at timestamptz := coalesce(p_run_at, now());
begin
  if p_mode not in ('keep','replace','debounce','append') then
    raise exception 'enqueue_job: bad mode %', p_mode;
  end if;
  if p_dedupe_key is null then
    return query
      insert into public.jobs (kind, user_id, run_at, payload, max_attempts)
      values (p_kind, p_user_id, v_run_at, coalesce(p_payload, '{}'::jsonb), p_max_attempts)
      returning jobs.id, jobs.run_at, now(), true;
    return;
  end if;
  return query
    insert into public.jobs as j (kind, user_id, run_at, payload, dedupe_key, max_attempts)
    values (p_kind, p_user_id, v_run_at, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, p_max_attempts)
    on conflict (dedupe_key) where status = 'pending' and dedupe_key is not null
    do update set
      run_at = case p_mode
        when 'keep'     then j.run_at
        when 'replace'  then excluded.run_at
        when 'debounce' then least(
                               greatest(j.run_at, excluded.run_at),
                               case when p_max_delay_ms is null then 'infinity'::timestamptz
                                    else j.created_at + make_interval(secs => p_max_delay_ms / 1000.0) end)
        else least(j.run_at, excluded.run_at)                                  -- append
      end,
      payload = case p_mode
        when 'keep'   then j.payload
        when 'append' then jsonb_set(
                             j.payload, '{items}',
                             coalesce(j.payload -> 'items', '[]'::jsonb)
                               || coalesce(excluded.payload -> 'items', '[]'::jsonb))
        else excluded.payload
      end
    returning j.id, j.run_at, now(), (j.xmax = 0);
end $$;

-- claim_jobs: SKIP LOCKED claim of due rows + reclaim of expired locks (no separate sweeper).
create or replace function public.claim_jobs(
  p_token uuid,
  p_kinds text[],
  p_limit int default 4,
  p_lock_seconds int default 330,
  p_job_id uuid default null,
  p_dedupe_key text default null)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'dead', finished_at = now(), locked_by = null, locked_until = null,
         last_error = left(coalesce(last_error, '') || ' | lock expired after max attempts', 1000)
   where status = 'running' and locked_until < now()
     and attempts >= max_attempts and kind = any(p_kinds);

  return query
    update public.jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           locked_until = now() + make_interval(secs => p_lock_seconds),
           locked_by = p_token,
           started_at = now()
     where j.id in (
       select c.id from public.jobs c
        where c.kind = any(p_kinds)
          and ((c.status = 'pending' and c.run_at <= now())
               or (c.status = 'running' and c.locked_until < now()))
          and (p_job_id is null or c.id = p_job_id)
          and (p_dedupe_key is null or c.dedupe_key = p_dedupe_key)
        order by c.run_at
        limit p_limit
        for update skip locked)
    returning j.*;
end $$;

-- finish_job: owner-checked transition; 'superseded' when a newer pending row owns the dedupe_key.
create or replace function public.finish_job(
  p_id uuid,
  p_token uuid,
  p_outcome text,                      -- done | retry | reschedule | dead
  p_run_at timestamptz default null,
  p_error text default null)
returns text                           -- 'done'|'pending'|'dead'|'superseded'|'lost'
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_exhausted boolean;
begin
  if p_outcome not in ('done','retry','reschedule','dead') then
    raise exception 'finish_job: bad outcome %', p_outcome;
  end if;
  select attempts >= max_attempts into v_exhausted
    from public.jobs where id = p_id and locked_by = p_token and status = 'running';
  if not found then return 'lost'; end if;

  if p_outcome = 'done' then
    update public.jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null
     where id = p_id returning status into v_status;
  elsif p_outcome = 'dead' or (p_outcome = 'retry' and v_exhausted) then
    update public.jobs set status = 'dead', finished_at = now(), locked_by = null, locked_until = null,
           last_error = left(p_error, 1000)
     where id = p_id returning status into v_status;
  else
    begin
      update public.jobs
         set status = 'pending', run_at = coalesce(p_run_at, now()),
             locked_by = null, locked_until = null,
             last_error = case when p_outcome = 'retry' then left(p_error, 1000) else last_error end,
             attempts = case when p_outcome = 'reschedule' then greatest(attempts - 1, 0) else attempts end
       where id = p_id returning status into v_status;
    exception when unique_violation then
      update public.jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null,
             last_error = 'superseded by newer pending job'
       where id = p_id;
      v_status := 'superseded';
    end;
  end if;
  return v_status;
end $$;

-- acquire_user_lease: DB-fallback per-user run lease (dev / no Upstash). Same call extends.
-- Release is a plain owner-filtered UPDATE from supabase-js.
create or replace function public.acquire_user_lease(p_user_id uuid, p_owner uuid, p_ttl_ms int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  insert into public.user_runtime as r (user_id, lease_until, lease_owner)
  values (p_user_id, now() + make_interval(secs => p_ttl_ms / 1000.0), p_owner)
  on conflict (user_id) do update
     set lease_until = excluded.lease_until, lease_owner = excluded.lease_owner
   where r.lease_until is null or r.lease_until < now() or r.lease_owner = p_owner
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- ingest_inbound_message: identity + signup match + idempotent insert in one transaction,
-- serialized per handle so a burst from a new handle yields exactly one user + channel.
create or replace function public.ingest_inbound_message(
  p_provider text,
  p_provider_line text,
  p_kind text,
  p_handle text,
  p_handle_kind text,
  p_service text,
  p_provider_message_id text,
  p_body text,
  p_media jsonb,
  p_reply_to_provider_id text,
  p_sent_at timestamptz,
  p_provider_opted_out boolean)
returns table (
  message_id uuid, duplicate boolean, user_id uuid, channel_id uuid, is_new_user boolean,
  user_name text, timezone text, timezone_source text,
  opted_out_at timestamptz, paused_until timestamptz, db_now timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_channel public.channels%rowtype;
  v_user    public.users%rowtype;
  v_signup  public.signups%rowtype;
  v_new     boolean := false;
  v_msg     uuid;
  v_reply   uuid;
  v_created timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('channel:' || p_kind || ':' || p_handle, 0));

  select * into v_channel from public.channels c where c.kind = p_kind and c.handle = p_handle;
  if not found then
    insert into public.users default values returning * into v_user;
    v_new := true;
    insert into public.channels (user_id, kind, handle, handle_kind, provider, provider_line,
                                 verified_at, last_service)
    values (v_user.id, p_kind, p_handle, p_handle_kind, p_provider, p_provider_line, now(), p_service)
    returning * into v_channel;
  else
    select * into v_user from public.users u where u.id = v_channel.user_id;
  end if;

  if p_handle_kind = 'phone' and v_user.name is null then
    select * into v_signup from public.signups s
     where s.phone_e164 = p_handle and s.expires_at > now() and s.matched_user_id is null
     order by s.created_at desc limit 1;
    if found then
      update public.users u
         set name = v_signup.name,
             timezone = coalesce(v_signup.timezone, u.timezone),
             timezone_source = case when v_signup.timezone is not null then 'signup' else u.timezone_source end
       where u.id = v_user.id returning * into v_user;
      update public.signups set matched_user_id = v_user.id where id = v_signup.id;
      insert into public.consents (user_id, channel_id, scope, granted, copy_version, source)
      values (v_user.id, v_channel.id, 'messaging', true, v_signup.consent_version, 'signup');
    end if;
  end if;

  if p_reply_to_provider_id is not null then
    select m.id into v_reply from public.messages m
     where m.provider = p_provider and m.provider_message_id = p_reply_to_provider_id;
  end if;

  v_created := case
    when p_sent_at between now() - interval '10 minutes' and now() + interval '1 minute' then p_sent_at
    else now() end;

  insert into public.messages (user_id, channel_id, direction, provider, provider_message_id,
                               body, media, reply_to_message_id, status, service, created_at)
  values (v_user.id, v_channel.id, 'in', p_provider, p_provider_message_id,
          p_body, p_media, v_reply, 'received', p_service, v_created)
  on conflict (provider, provider_message_id) do nothing
  returning id into v_msg;

  update public.channels c
     set last_inbound_at = greatest(coalesce(c.last_inbound_at, v_created), v_created),
         last_service    = coalesce(p_service, c.last_service),
         opted_out_at    = case when p_provider_opted_out and c.opted_out_at is null then now()
                                else c.opted_out_at end
   where c.id = v_channel.id
  returning * into v_channel;

  return query select v_msg, v_msg is null, v_user.id, v_channel.id, v_new,
                      v_user.name, v_user.timezone, v_user.timezone_source,
                      v_channel.opted_out_at, v_channel.paused_until, now();
end $$;

-- purge_messages_before: batched retention delete (reactions cascade).
create or replace function public.purge_messages_before(p_before timestamptz, p_limit int default 5000)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with doomed as (
    select id from public.messages where created_at < p_before order by created_at limit p_limit)
  delete from public.messages m using doomed d where m.id = d.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- decide_preference: atomic confirm/reject; closes the old active row before activating.
create or replace function public.decide_preference(p_user uuid, p_pref uuid, p_decision text)
returns public.user_preferences
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.user_preferences;
  v_old uuid;
begin
  select * into v_row from public.user_preferences
   where id = p_pref and user_id = p_user and status in ('proposed','queued')
   for update;
  if not found then
    raise exception 'preference_not_open' using errcode = 'P0002';
  end if;

  if p_decision = 'reject' then
    update public.user_preferences
       set status = 'rejected', valid_to = now(), decided_at = now()
     where id = p_pref returning * into v_row;
    return v_row;
  elsif p_decision <> 'confirm' then
    raise exception 'bad_decision' using errcode = '22023';
  end if;

  select id into v_old from public.user_preferences
   where user_id = p_user and key = v_row.key and status = 'active'
   for update;
  if v_old is not null then
    update public.user_preferences
       set status = 'superseded', valid_to = now(), superseded_by = p_pref
     where id = v_old;
  end if;

  update public.user_preferences
     set status = 'active', valid_from = now(), decided_at = now(),
         source = coalesce(source, 'confirmed')
   where id = p_pref returning * into v_row;
  return v_row;
end $$;

-- recall_facts: FTS (OR of query words) blended with a 30-day recency decay.
create or replace function public.recall_facts(
  p_user uuid, p_query text, p_limit int default 8, p_recency_weight real default 0.3)
returns table (id uuid, content text, category text, created_at timestamptz, score real)
language sql stable security definer set search_path = '' as $$
  with q as (
    select websearch_to_tsquery('english',
             array_to_string(regexp_split_to_array(
               trim(regexp_replace(coalesce(p_query, ''), '[^[:alnum:][:space:]]', ' ', 'g')),
               '\s+'), ' or ')) as tsq
  )
  select f.id, f.content, f.category, f.created_at,
         ( (1 - p_recency_weight) * ts_rank_cd(f.tsv, q.tsq)
         + p_recency_weight * exp(- extract(epoch from (now() - f.updated_at)) / (86400.0 * 30))
         )::real as score
    from public.memory_facts f, q
   where f.user_id = p_user
     and f.deleted_at is null
     and (f.expires_at is null or f.expires_at > now())
     and f.tsv @@ q.tsq
   order by score desc, f.created_at desc
   limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

-- claim_escalation: hard 10%-of-LLM-turns cap, trailing 7 days, global, evals excluded.
create or replace function public.claim_escalation(
  p_run uuid, p_reason text, p_pct int default 10, p_window interval default interval '7 days')
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_total int; v_esc int;
begin
  perform pg_advisory_xact_lock(hashtext('aria.escalation_budget'));
  select count(*), count(*) filter (where escalated)
    into v_total, v_esc
    from public.agent_runs
   where started_at > now() - p_window
     and model is not null and not is_eval;      -- includes p_run (model set when the LLM run starts)
  if (v_esc + 1) * 100 > p_pct * v_total then
    return false;
  end if;
  update public.agent_runs set escalated = true, escalation_reason = p_reason where id = p_run;
  return true;
end $$;

-- timeline_apply: atomic apply of one computed diff (rekeys → upserts → soft-removes).
-- Returns [{id, external_id}] of every touched row so TS can build the change batch.
create or replace function public.timeline_apply(
  p_user_id    uuid,
  p_source     text,
  p_rekeys     jsonb  default '[]'::jsonb,   -- [{id, new_external_id}]
  p_upserts    jsonb  default '[]'::jsonb,   -- [{external_id, kind, title, course, starts_at, ends_at, due_at, all_day, url, timing_key, match_key, raw}]
  p_remove_ids uuid[] default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_out jsonb;
begin
  update public.timeline_items t
     set external_id = r.new_external_id, updated_at = v_now
    from jsonb_to_recordset(p_rekeys) as r(id uuid, new_external_id text)
   where t.id = r.id and t.user_id = p_user_id and t.source = p_source;

  insert into public.timeline_items as t
    (user_id, source, external_id, kind, title, course, starts_at, ends_at, due_at,
     all_day, url, timing_key, match_key, raw, removed_at, updated_at)
  select p_user_id, p_source, u.external_id, u.kind, u.title, u.course, u.starts_at,
         u.ends_at, u.due_at, coalesce(u.all_day, false), u.url, u.timing_key,
         u.match_key, u.raw, null, v_now
    from jsonb_to_recordset(p_upserts) as u(
         external_id text, kind text, title text, course text,
         starts_at timestamptz, ends_at timestamptz, due_at timestamptz,
         all_day boolean, url text, timing_key text, match_key text, raw jsonb)
  on conflict (user_id, source, external_id) do update set
         kind = excluded.kind, title = excluded.title, course = excluded.course,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         due_at = excluded.due_at, all_day = excluded.all_day, url = excluded.url,
         timing_key = excluded.timing_key, match_key = excluded.match_key,
         raw = excluded.raw, removed_at = null, updated_at = v_now;

  update public.timeline_items
     set removed_at = v_now, updated_at = v_now
   where user_id = p_user_id and source = p_source
     and id = any(p_remove_ids) and removed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'external_id', t.external_id)), '[]'::jsonb)
    into v_out
    from public.timeline_items t
   where t.user_id = p_user_id and t.source = p_source
     and (   t.external_id in (select x->>'external_id' from jsonb_array_elements(p_upserts) x)
          or t.id = any(p_remove_ids)
          or t.id in (select (x->>'id')::uuid from jsonb_array_elements(p_rekeys) x));
  return v_out;
end $$;

-- advance_gmail_cursor: monotonic forward advance; p_force = compare-and-set reset after a 404 resync.
create or replace function public.advance_gmail_cursor(
  p_integration_id uuid,
  p_new            text,
  p_expected       text default null,
  p_force          boolean default false)
returns boolean
language sql security definer set search_path = '' as $$
  with upd as (
    update public.integrations
       set gmail_history_id = p_new,
           gmail_synced_at  = now()
     where id = p_integration_id
       -- CASE (not AND) so the ::numeric casts can never run on a non-numeric p_new or a
       -- non-numeric stored value: the planner may reorder AND-ed quals.
       and case
             when p_new !~ '^[0-9]{1,20}$' then false
             when p_force then gmail_history_id is not distinct from p_expected
             when gmail_history_id is null then true
             when gmail_history_id !~ '^[0-9]{1,20}$' then false
             else gmail_history_id::numeric < p_new::numeric
           end
    returning 1
  )
  select exists (select 1 from upd);
$$;

-- private.jobs_tick: POST to /api/jobs/dispatch only when work is due.
-- No-op (returns null) until Vault holds aria_dispatch_url + aria_dispatch_secret
-- (runbook: scripts/ops/configure-jobs-tick.sql, master plan §7).
create or replace function private.jobs_tick() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'aria_dispatch_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'aria_dispatch_secret');
  v_ts  text;
begin
  if v_url is null or v_key is null then return null; end if;
  if not exists (
    select 1 from public.jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'running' and locked_until < now())) then
    return null;
  end if;
  v_ts := extract(epoch from clock_timestamp())::bigint::text;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-aria-ts', v_ts,
      'x-aria-sig', encode(extensions.hmac('v1.' || v_ts, v_key, 'sha256'), 'hex')),
    timeout_milliseconds := 5000);
end $$;

-- ═══ §13 Grants: service_role only ═════════════════════════════════════════
revoke execute on function public.enqueue_job(text,uuid,timestamptz,jsonb,text,text,int,int)            from public, anon, authenticated;
revoke execute on function public.claim_jobs(uuid,text[],int,int,uuid,text)                             from public, anon, authenticated;
revoke execute on function public.finish_job(uuid,uuid,text,timestamptz,text)                           from public, anon, authenticated;
revoke execute on function public.acquire_user_lease(uuid,uuid,int)                                     from public, anon, authenticated;
revoke execute on function public.ingest_inbound_message(text,text,text,text,text,text,text,text,jsonb,text,timestamptz,boolean) from public, anon, authenticated;
revoke execute on function public.purge_messages_before(timestamptz,int)                                from public, anon, authenticated;
revoke execute on function public.decide_preference(uuid,uuid,text)                                     from public, anon, authenticated;
revoke execute on function public.recall_facts(uuid,text,int,real)                                      from public, anon, authenticated;
revoke execute on function public.claim_escalation(uuid,text,int,interval)                              from public, anon, authenticated;
revoke execute on function public.timeline_apply(uuid,text,jsonb,jsonb,uuid[])                          from public, anon, authenticated;
revoke execute on function public.advance_gmail_cursor(uuid,text,text,boolean)                          from public, anon, authenticated;
revoke execute on function private.jobs_tick()                                                          from public, anon, authenticated;

grant execute on function public.enqueue_job(text,uuid,timestamptz,jsonb,text,text,int,int)            to service_role;
grant execute on function public.claim_jobs(uuid,text[],int,int,uuid,text)                             to service_role;
grant execute on function public.finish_job(uuid,uuid,text,timestamptz,text)                           to service_role;
grant execute on function public.acquire_user_lease(uuid,uuid,int)                                     to service_role;
grant execute on function public.ingest_inbound_message(text,text,text,text,text,text,text,text,jsonb,text,timestamptz,boolean) to service_role;
grant execute on function public.purge_messages_before(timestamptz,int)                                to service_role;
grant execute on function public.decide_preference(uuid,uuid,text)                                     to service_role;
grant execute on function public.recall_facts(uuid,text,int,real)                                      to service_role;
grant execute on function public.claim_escalation(uuid,text,int,interval)                              to service_role;
grant execute on function public.timeline_apply(uuid,text,jsonb,jsonb,uuid[])                          to service_role;
grant execute on function public.advance_gmail_cursor(uuid,text,text,boolean)                          to service_role;

-- ═══ §14 pg_cron (supersedes 002's "lands with V2-06" note) ═══════════════
-- 15s dispatch tick: no-op until Vault secrets are set after the first deploy.
select cron.schedule('aria-jobs-tick', '15 seconds', $$ select private.jobs_tick(); $$);
-- Daily retention (handler: src/server/jobs/kinds/retention-purge.ts).
select cron.schedule('aria-retention-enqueue', '17 8 * * *',
  $$ select public.enqueue_job('retention_purge', null, now(), '{}'::jsonb, 'retention_purge', 'keep'); $$);
-- pg_cron never cleans its own history; the 15s tick writes ~5,760 rows/day.
select cron.schedule('aria-cron-history-purge', '0 4 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $$);
-- Materialize due Canvas syncs as jobs (integrations.next_sync_at is the source of truth).
select cron.schedule('canvas-sync-enqueue', '*/5 * * * *', $cron$
  insert into public.jobs (kind, user_id, run_at, dedupe_key)
  select 'canvas_sync', i.user_id, greatest(i.next_sync_at, now()), 'canvas_sync:' || i.user_id
    from public.integrations i
    join public.users u on u.id = i.user_id and u.deleted_at is null
   where i.provider = 'canvas_ical'
     and i.status in ('active','error')
     and i.next_sync_at is not null
     and i.next_sync_at <= now() + interval '5 minutes'
     and not exists (
       select 1 from public.jobs j
        where j.dedupe_key = 'canvas_sync:' || i.user_id
          and j.status in ('pending','running'))
  on conflict (dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
$cron$);
-- Purge long soft-removed timeline items.
select cron.schedule('timeline-cleanup', '17 4 * * *', $cron$
  delete from public.timeline_items where removed_at < now() - interval '120 days';
$cron$);

-- ═══ §15 RLS: enable on every public table (deny-all; no policies) ═════════
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
