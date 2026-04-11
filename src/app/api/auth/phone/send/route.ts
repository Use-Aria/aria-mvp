import { NextRequest, NextResponse } from 'next/server'
import twilio from 'twilio'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/phone/send
 * Initiates a Twilio Verify OTP for phone number verification.
 *
 * Auth: JWT required — user must be signed in via Supabase Auth.
 * Uses TWILIO_VERIFY_SERVICE_SID (separate from TWILIO_ACCOUNT_SID/TWILIO_PHONE_NUMBER).
 *
 * Accepts phone in any format — Twilio Verify normalises to E.164 internally.
 * Returns 400 if format is wholly unparseable.
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

    const { phone } = body as Record<string, unknown>

    if (typeof phone !== 'string' || phone.trim().length === 0) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 })
    }

    // --- Validate env ---
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
      console.error('[auth/phone/send] Twilio Verify env vars not configured')
      return NextResponse.json({ error: 'SMS service not configured' }, { status: 500 })
    }

    // --- Send OTP via Twilio Verify ---
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

    try {
      await client.verify.v2
        .services(TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: phone.trim(), channel: 'sms' })
    } catch (twilioErr: unknown) {
      const message = twilioErr instanceof Error ? twilioErr.message : String(twilioErr)
      // Twilio returns 60200 for invalid phone number format
      if (message.includes('60200') || message.toLowerCase().includes('invalid')) {
        return NextResponse.json({ error: 'Invalid phone number format' }, { status: 400 })
      }
      console.error('[auth/phone/send] Twilio Verify error:', message)
      return NextResponse.json({ error: 'Failed to send verification code' }, { status: 500 })
    }

    console.log('[auth/phone/send] OTP sent for user:', user.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[auth/phone/send] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
