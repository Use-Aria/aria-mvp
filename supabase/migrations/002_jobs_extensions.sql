-- Aria V2 — extensions for the jobs tick (spec §4.4).
-- pg_cron runs the 15s tick; pg_net lets it POST to /api/jobs/dispatch.
-- The cron.schedule(...) call itself lands with V2-06, once there is a
-- deployed dispatch URL and the HMAC secret is stored in Vault.

create extension if not exists pg_cron;                      -- Supabase installs into pg_catalog
create extension if not exists pg_net with schema extensions; -- functions live in schema `net`
