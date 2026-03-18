import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/sms/webhook
 * Twilio inbound SMS webhook stub.
 *
 * Phase 1: Returns HTTP 200 immediately and logs the inbound payload.
 * Phase 3: Full SMS processing (signature validation, reply logic) added here.
 *
 * Security: Phone numbers (From field) are intentionally omitted from logs.
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 *
 * Twilio requires HTTP 200 on all responses — even on errors — or it retries.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text()
    const params = Object.fromEntries(new URLSearchParams(body))
    // Log MessageSid and NumMedia for observability. From is omitted — phone numbers must not appear in logs.
    console.log('[sms/webhook] inbound:', {
      MessageSid: params['MessageSid'],
      NumMedia: params['NumMedia'],
      // From: intentionally omitted — CLAUDE.md: phone numbers hashed in logs
    })
    return new NextResponse('', { status: 200 })
  } catch (err) {
    console.error('[sms/webhook] error:', err)
    return new NextResponse('', { status: 200 }) // always 200 to Twilio
  }
}
