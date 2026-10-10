-- Drop NOT NULL constraint on "Email" column added via Supabase dashboard.
-- Auth is phone-based; email is not required for user creation.
ALTER TABLE public.users ALTER COLUMN "Email" DROP NOT NULL;
