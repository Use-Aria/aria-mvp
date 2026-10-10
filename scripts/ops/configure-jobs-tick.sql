-- OWNER: 1.1
-- ════════════════════════════════════════════════════════════════════════════
-- RUNBOOK (not a migration): point the pg_cron jobs tick at the deployed app.
-- V2-03 §2.11 "Tick", §11 T9; master plan §7.2.
--
-- `aria-jobs-tick` (003 §14) runs `private.jobs_tick()` every 15s. It is a no-op until
-- Vault holds BOTH secrets below; then it POSTs a signed request to /api/jobs/dispatch
-- whenever a job is due or a lock has expired.
--
-- Run in the Supabase SQL editor (or psql) AFTER the first Vercel deploy, once
-- JOBS_DISPATCH_SECRET is set in Vercel (`openssl rand -hex 32`). The two values must match.
-- Never commit the filled-in values. Run it section by section (2c needs ~5-30s after 2b,
-- and 2e deletes the check rows).
-- Verified 2026-10-10 on the local stack (URL http://host.docker.internal:<dev port>/api/jobs/dispatch): the tick
-- POSTed, got 202, and the noop job was done within ~7s.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Create or update the secrets (edit the two placeholders, run the block) ──
do $$
declare
  v_url    text := '<APP_BASE_URL>/api/jobs/dispatch';   -- e.g. https://aria-xyz.vercel.app/api/jobs/dispatch
  v_secret text := '<JOBS_DISPATCH_SECRET>';             -- same value as the Vercel env var
  v_id     uuid;
begin
  if v_url like '<%' or v_secret like '<%' then
    raise exception 'edit the placeholders first';
  end if;
  if v_url not like 'https://%' then
    raise warning 'dispatch URL is not https (ok only for a local stack): %', v_url;
  end if;
  if length(v_secret) < 32 then
    raise exception 'dispatch secret is too short (use openssl rand -hex 32)';
  end if;

  select id into v_id from vault.secrets where name = 'aria_dispatch_url';
  if v_id is null then
    perform vault.create_secret(v_url, 'aria_dispatch_url', 'Aria: /api/jobs/dispatch URL for private.jobs_tick');
  else
    perform vault.update_secret(v_id, v_url);
  end if;

  select id into v_id from vault.secrets where name = 'aria_dispatch_secret';
  if v_id is null then
    perform vault.create_secret(v_secret, 'aria_dispatch_secret', 'Aria: HMAC key for /api/jobs/dispatch (= JOBS_DISPATCH_SECRET)');
  else
    perform vault.update_secret(v_id, v_secret);
  end if;
end $$;

-- ── 2. Verify ──────────────────────────────────────────────────────────────
-- 2a. Both secrets present (prints names only, never values).
select name, updated_at from vault.secrets
 where name in ('aria_dispatch_url', 'aria_dispatch_secret');

-- 2b. Enqueue a due noop job, then fire the tick by hand (returns a pg_net request id,
--     or null when nothing is due / Vault is incomplete).
select job_id from public.enqueue_job('noop', null, now(), '{"note":"tick-check"}'::jsonb, null, 'replace', null, 1);
select private.jobs_tick();

-- 2c. ~5-30s later: the request got 202 and the noop job is done.
select id, status_code, error_msg, created
  from net._http_response order by created desc limit 5;
select id, status, attempts, last_error, finished_at
  from public.jobs where kind = 'noop' and payload ->> 'note' = 'tick-check'
 order by created_at desc limit 5;

-- 2d. The 15s schedule itself is running.
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname = 'aria-jobs-tick'
 order by d.start_time desc limit 5;

-- 2e. Clean up the check rows.
delete from public.jobs where kind = 'noop' and payload ->> 'note' = 'tick-check';

-- ── 3. Rotate the secret (zero-downtime is not needed: a missed tick is retried 15s later) ──
-- 1) set the new JOBS_DISPATCH_SECRET in Vercel and redeploy; 2) then:
-- select vault.update_secret((select id from vault.secrets where name = 'aria_dispatch_secret'), '<NEW_SECRET>');

-- ── 4. Pause the tick (back to the no-op state) ────────────────────────────
-- delete from vault.secrets where name in ('aria_dispatch_url', 'aria_dispatch_secret');
-- (or: select cron.unschedule('aria-jobs-tick'); — re-create with 003 §14's cron.schedule line)

-- ── Troubleshooting ────────────────────────────────────────────────────────
-- • status_code 401: Vault secret ≠ Vercel JOBS_DISPATCH_SECRET, or DB/Vercel clocks differ by >60s.
-- • error_msg "Timeout": cold start exceeded pg_net's 5s; dispatch still runs if the request
--   reached Vercel (check function logs). Jobs are reclaimed on the next tick either way.
-- • No rows in net._http_response: nothing was due, or a secret is missing (2a).
-- • Daily backstop: Vercel Cron GETs /api/jobs/dispatch at 12:00 UTC with Bearer CRON_SECRET
--   (vercel.json); set CRON_SECRET in Vercel.
