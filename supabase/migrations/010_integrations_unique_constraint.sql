-- Add unique constraint on (user_id, platform) to integrations table.
-- Required for upsert idempotency in encrypt_and_store_tokens Celery task
-- and the Google OAuth callback dev fallback path.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_user_platform_unique
  ON public.integrations (user_id, platform);
