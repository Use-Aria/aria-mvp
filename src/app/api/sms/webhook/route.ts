import { NextRequest, NextResponse } from 'next/server'
import twilio from 'twilio'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import { enqueueCeleryTask } from '@/lib/celery/enqueue'

/**
 * POST /api/sms/webhook
 * Twilio inbound SMS webhook — Phase 3 implementation.
 *
 * 1. Validates Twilio signature (bypassed in dev via TWILIO_DEV_BYPASS=true).
 * 2. Looks up the sending user by phone number.
 * 3. Writes inbound message to messages table (direction='in').
 * 4. Enqueues process_inbound_sms Celery task via Redis LPUSH.
 * 5. Always returns HTTP 200 to legitimate Twilio requests (403 on spoof only).
 *
 * Security: Phone numbers (From field) are never included in any log statement.
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 *
 * CRITICAL: Uses TWILIO_WEBHOOK_URL env var for signature validation — never
 * reconstruct URL from request.url due to proxy/Vercel header mismatch pitfall.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text()
    const params = Object.fromEntries(new URLSearchParams(body))

    // --- Step 1: Validate Twilio signature (skip in dev with TWILIO_DEV_BYPASS=true) ---
    if (process.env.TWILIO_DEV_BYPASS !== 'true') {
      const signature = request.headers.get('x-twilio-signature') || ''
      const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN!,
        signature,
        process.env.TWILIO_WEBHOOK_URL!,
        params,
      )
      if (!isValid) {
        console.warn('[sms/webhook] invalid signature — possible spoof')
        return new NextResponse('Forbidden', { status: 403 })
      }
    }

    // --- Step 2: Look up user by phone number (service role — bypasses RLS) ---
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Twilio sends E.164 (+15551234567). Rows written before phone normalization hold the
    // Supabase Auth digits-only form (15551234567) — match either.
    const from = params['From'] || ''
    const fromDigits = from.replace(/^\+/, '')
    if (!fromDigits) {
      return new NextResponse('', { status: 200 })
    }
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('id')
      .in('phone', [`+${fromDigits}`, fromDigits])
      .limit(1)
      .single()

    if (userError || !userRow) {
      // Do not expose information to unknown senders — just return 200.
      console.log('[sms/webhook] unknown sender (no user match)')
      return new NextResponse('', { status: 200 })
    }

    const userId = userRow.id

    // --- Step 3: Write inbound message to messages table before enqueueing ---
    const { error: insertError } = await supabase.from('messages').insert({
      user_id: userId,
      direction: 'in',
      body: params['Body'] || '',
      sent_at: new Date().toISOString(),
      trigger_type: 'sms_inbound',
    })

    if (insertError) {
      // Log error but continue — DB write failure should not block Celery enqueue
      console.error('[sms/webhook] failed to write message to DB:', insertError.message)
    } else {
      // Never log From or Body — only the Twilio MessageSid for tracing
      console.log('[sms/webhook] inbound recorded:', { MessageSid: params['MessageSid'] })
    }

    // --- Step 4: Enqueue process_inbound_sms Celery task via Redis ---
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')

    try {
      // Args: [message_sid, body, user_id] — user_id is UUID, never phone number
      await enqueueCeleryTask(redis, 'tasks.process_inbound_sms', [
        params['MessageSid'] || '',
        params['Body'] || '',
        userId,
      ])
    } finally {
      await redis.quit()
    }

    // --- Step 5: Return 200 to Twilio ---
    return new NextResponse('', { status: 200 })
  } catch (err) {
    console.error('[sms/webhook] error:', err)
    // Always return 200 to prevent Twilio from retrying with exponential backoff.
    return new NextResponse('', { status: 200 })
  }
}
