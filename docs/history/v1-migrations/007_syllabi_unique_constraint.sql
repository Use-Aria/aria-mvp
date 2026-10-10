-- 007: Add unique constraint for syllabus upsert on (user_id, course_name)
-- Required by upsert_syllabus() ON CONFLICT(user_id, course_name).
-- IMPORTANT: Never run this migration without notifying the other developer first (CLAUDE.md schema rule).
ALTER TABLE public.syllabi
  ADD CONSTRAINT syllabi_user_course_unique UNIQUE (user_id, course_name);
