-- supabase/migrations/003_tcpa_columns.sql
-- Add TCPA compliance columns to users table for Phase 3 SMS pipeline.
-- These columns are queried on every outbound SMS — must be indexable, not in preferences_json.
-- IMPORTANT: Never run this migration without notifying the other developer first (CLAUDE.md schema rule).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sms_paused_until TIMESTAMPTZ;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_sms_count INT NOT NULL DEFAULT 0;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_sms_date DATE;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS quiet_hours_start TIME DEFAULT '22:00';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS quiet_hours_end TIME DEFAULT '08:00';

-- Partial index for paused users (negligible cost, useful at scale)
CREATE INDEX IF NOT EXISTS idx_users_sms_paused
  ON public.users (id) WHERE sms_paused_until IS NOT NULL;

-- Index for opt-out lookups
CREATE INDEX IF NOT EXISTS idx_users_sms_opted_out
  ON public.users (id) WHERE sms_opted_out = true;
