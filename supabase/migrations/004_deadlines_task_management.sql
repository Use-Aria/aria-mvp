-- supabase/migrations/004_deadlines_task_management.sql
-- Phase 4: Task management columns for SMS commands (mark complete, snooze, priority)
-- Adds status, snoozed_until, and priority to deadlines table.
-- IMPORTANT: Never run this migration without notifying the other developer first (CLAUDE.md schema rule).

ALTER TABLE public.deadlines
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'upcoming',
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority VARCHAR DEFAULT 'normal';

-- Index for active non-snoozed deadlines (briefing query optimization)
CREATE INDEX IF NOT EXISTS idx_deadlines_briefing
  ON public.deadlines (user_id, due_date)
  WHERE deleted_at IS NULL AND status != 'completed';
