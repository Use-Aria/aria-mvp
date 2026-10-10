-- supabase/migrations/001_initial_schema.sql
-- All 8 core tables with RLS policies and auto-user trigger.
-- Schema only — no seed data or test fixtures.
-- IMPORTANT: Never run this migration without notifying the other developer first (CLAUDE.md schema rule).

-- ─────────────────────────────────────────────────────────────────────────────
-- users: app-specific profile, FK to auth.users (managed by Supabase Auth)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  university TEXT,
  graduation_year INT,
  preferences_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own row" ON public.users
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- Auto-create a public.users row whenever a new auth.users row is inserted
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- integrations: OAuth tokens and iCal URLs per platform per user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  ical_url TEXT,
  connected_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.integrations FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- deadlines: Canvas assignments and exams synced via iCal
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.deadlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  canvas_uid TEXT,
  title TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  course TEXT,
  type TEXT,
  grade_weight NUMERIC,
  last_synced TIMESTAMPTZ
);

ALTER TABLE public.deadlines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.deadlines FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- syllabi: uploaded course syllabi with Claude-parsed structured data
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.syllabi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  course_name TEXT,
  raw_text TEXT,
  parsed_json JSONB,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.syllabi ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.syllabi FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- calendar_events: Google Calendar events synced via OAuth
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  google_event_id TEXT,
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  type TEXT
);

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.calendar_events FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- tasks: Todoist tasks synced via OAuth (Phase 2+)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  todoist_id TEXT,
  title TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  priority INT,
  completed BOOLEAN DEFAULT false
);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.tasks FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- messages: inbound and outbound SMS messages via Twilio
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  trigger_type TEXT
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.messages FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- spotify_sessions: Spotify focus session data (Phase 2+, schema only now)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.spotify_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  playlist_uri TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INT
);

ALTER TABLE public.spotify_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.spotify_sessions FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
