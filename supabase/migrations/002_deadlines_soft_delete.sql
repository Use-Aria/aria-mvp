-- supabase/migrations/002_deadlines_soft_delete.sql
-- Add soft-delete support to deadlines table for Phase 2 Canvas sync.
-- Phase 5 uses deleted_at to alert users when a deadline disappears from Canvas.

-- Soft-delete column: NULL = active, non-NULL = deleted at that timestamp
ALTER TABLE public.deadlines
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Index for efficient filtering of active (non-deleted) deadlines
CREATE INDEX IF NOT EXISTS idx_deadlines_active
  ON public.deadlines (user_id, deleted_at)
  WHERE deleted_at IS NULL;

-- Unique constraint required for supabase-py upsert on_conflict="canvas_uid,user_id"
-- canvas_uid is NOT globally unique — must always be scoped with user_id
ALTER TABLE public.deadlines
  ADD CONSTRAINT deadlines_canvas_uid_user_id_key
  UNIQUE (canvas_uid, user_id);
