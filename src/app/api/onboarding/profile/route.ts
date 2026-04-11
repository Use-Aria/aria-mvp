import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/onboarding/profile
 * Saves user profile fields (name, university, graduation_year) to the users table.
 * Phone is read from the authenticated Supabase session (set by phone OTP auth).
 *
 * Auth: JWT required — user must be signed in via Supabase phone auth.
 * The user row is upserted by auth UID.
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // --- Auth: resolve user from JWT ---
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // --- Parse and validate request body ---
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { name, university, graduation_year } = body as Record<string, unknown>

    if (
      typeof name !== 'string' || name.trim().length === 0 ||
      typeof university !== 'string' || university.trim().length === 0 ||
      typeof graduation_year !== 'number' || !Number.isInteger(graduation_year) ||
      graduation_year < 2020 || graduation_year > 2035
    ) {
      return NextResponse.json(
        { error: 'name, university, and graduation_year (integer 2020–2035) are required' },
        { status: 400 },
      )
    }

    // Phone comes from Supabase session (set by phone OTP auth — already E.164)
    const phone = user.phone ?? ''

    // --- Write to DB using service role (bypasses RLS) ---
    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { error: upsertError } = await adminClient
      .from('users')
      .upsert(
        {
          id: user.id,
          name: name.trim(),
          phone,
          university: university.trim(),
          graduation_year,
        },
        { onConflict: 'id' },
      )

    if (upsertError) {
      console.error('[onboarding/profile] DB upsert failed:', upsertError.message)
      return NextResponse.json({ error: 'Failed to save profile' }, { status: 500 })
    }

    console.log('[onboarding/profile] profile saved for user:', user.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[onboarding/profile] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
