import { NextResponse } from 'next/server'

const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ANTHROPIC_API_KEY',
  'TWILIO_WEBHOOK_URL', // without it every inbound SMS fails signature validation
  'REDIS_URL', // without it every Celery enqueue targets localhost
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
]

/**
 * GET /api/health
 * Verifies all required environment variables are set.
 * Returns 200 with { ok: true, checked: N } when all vars are present.
 * Returns 500 with { ok: false, missing: [...] } when any vars are absent.
 */
export async function GET() {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k])
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, missing }, { status: 500 })
  }
  return NextResponse.json({ ok: true, checked: REQUIRED_ENV_VARS.length })
}
