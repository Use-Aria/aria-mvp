-- Add onboarding completion tracking columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
