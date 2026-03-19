-- Phase 5: Canonical Timeline DB — unified event store for all integrations.
-- Canvas deadlines are backfilled into this table via Celery task on deploy.
-- IMPORTANT: Never run this migration without notifying the other developer first.

CREATE TABLE public.canonical_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('canvas', 'gcal', 'gmail', 'todoist')),
  type TEXT,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  course_id TEXT,
  grade_weight NUMERIC,
  priority_score INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'silent'
    CHECK (delivery_status IN ('immediate', 'digest', 'silent', 'sent')),
  snoozed_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, source, title, due_at)
);

ALTER TABLE public.canonical_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.canonical_events FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE INDEX idx_canonical_events_briefing
  ON public.canonical_events (user_id, due_at)
  WHERE deleted_at IS NULL
    AND delivery_status IN ('digest', 'immediate');

CREATE INDEX idx_canonical_events_delivery
  ON public.canonical_events (user_id, delivery_status, created_at)
  WHERE delivery_status = 'immediate';
