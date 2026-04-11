import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import twilio from 'twilio'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/phone/verify
 * Verifies a 6-digit OTP sent by /api/auth/phone/send, then marks the user's
 * phone as verified in the users table.
 *
 * Auth: JWT required.
 *
 * Response codes:
 *   200 { ok: true }             — OTP correct, phone_verified set to true
 *   400                          — missing/invalid fields
 *   401                          — not authenticated
 *   410                          — code expired (Twilio status: expired)
 *   422                          — wrong code (Twilio status: pending after failed check)
 *   500                          — internal / Twilio error
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // --- Auth ---
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // --- Parse body ---
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { phone, code } = body as Record<string, unknown>

    if (typeof phone !== 'string' || phone.trim().length === 0) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 })
    }
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'code must be a 6-digit string' }, { status: 400 })
    }

    // --- Validate env ---
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
      console.error('[auth/phone/verify] Twilio Verify env vars not configured')
      return NextResponse.json({ error: 'SMS service not configured' }, { status: 500 })
    }

    // --- Check OTP via Twilio Verify ---
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

    let verificationStatus: string
    try {
      const check = await client.verify.v2
        .services(TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phone.trim(), code })
      verificationStatus = check.status
    } catch (twilioErr: unknown) {
      const message = twilioErr instanceof Error ? twilioErr.message : String(twilioErr)
      // Twilio throws 20404 when the verification has already expired or been used
      if (message.includes('20404') || message.toLowerCase().includes('not found')) {
        return NextResponse.json({ error: 'Verification code expired' }, { status: 410 })
      }
      console.error('[auth/phone/verify] Twilio error:', message)
      return NextResponse.json({ error: 'Failed to verify code' }, { status: 500 })
    }

    if (verificationStatus === 'approved') {
      // --- Mark phone_verified in DB ---
      const adminClient = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      )

      const { error: updateError } = await adminClient
        .from('users')
        .update({ phone_verified: true })
        .eq('id', user.id)

      if (updateError) {
        console.error('[auth/phone/verify] DB update failed:', updateError.message)
        return NextResponse.json({ error: 'Failed to update verification status' }, { status: 500 })
      }

      console.log('[auth/phone/verify] phone verified for user:', user.id)
      return NextResponse.json({ ok: true })
    }

    // status is 'pending' (wrong code) or 'expired'
    if (verificationStatus === 'expired') {
      return NextResponse.json({ error: 'Verification code expired' }, { status: 410 })
    }

    return NextResponse.json({ error: 'Wrong code, please try again' }, { status: 422 })
  } catch (err) {
    console.error('[auth/phone/verify] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
