-- Phase 6: Google OAuth + Gmail + GCal schema additions.
-- Adds gmail_flags and conflict_alerts tables, and watch channel columns to integrations.
-- IMPORTANT: Never run this migration without notifying the other developer first (CLAUDE.md schema rule).

-- ─────────────────────────────────────────────────────────────────────────────
-- gmail_flags: metadata from .edu emails classified by Claude Haiku
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.gmail_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  flagged_at TIMESTAMPTZ DEFAULT now(),
  summary TEXT,
  confidence NUMERIC,
  matched_deadline_id UUID REFERENCES public.deadlines(id)
);

ALTER TABLE public.gmail_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.gmail_flags FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- conflict_alerts: deduplication table for GCal conflict detection
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.conflict_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  deadline_id UUID NOT NULL REFERENCES public.deadlines(id),
  gcal_event_id TEXT NOT NULL,
  fired_at TIMESTAMPTZ DEFAULT now(),
  deadline_due_at TIMESTAMPTZ,
  gcal_event_date DATE,
  UNIQUE (user_id, deadline_id, gcal_event_id)
);

ALTER TABLE public.conflict_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.conflict_alerts FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Add GCal push notification watch channel columns to integrations
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS resource_id TEXT,
  ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_id TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Add unique constraint on calendar_events for GCal upsert idempotency
-- Required by store_calendar_events() ON CONFLICT(user_id, google_event_id)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_user_event_unique
  ON public.calendar_events (user_id, google_event_id);
