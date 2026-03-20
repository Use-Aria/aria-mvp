import { NextResponse } from 'next/server'
import Redis from 'ioredis'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/gmail/webhook
 * Gmail Pub/Sub push notification receiver — Phase 6 implementation.
 *
 * Gmail sends Pub/Sub push notifications when new emails arrive.
 * The notification body contains a base64url-encoded JSON payload:
 *   { "emailAddress": "user@yale.edu", "historyId": "12345" }
 *
 * Protocol:
 * 1. Decode base64url message.data -> {emailAddress, historyId}.
 * 2. Look up all Google-connected users (future: match by email address).
 * 3. Dispatch gmail_process_notification task via Redis for each user.
 * 4. Always return 200 — Pub/Sub retries on non-200 responses.
 *
 * Privacy: Per CLAUDE.md, phone numbers are never logged in plaintext.
 * This route logs only historyId and emailAddress (not user PII).
 *
 * NOTE: Current MVP behavior dispatches to all Google-connected users.
 * TODO: Add google_email column to integrations during OAuth for precise matching.
 * GMAIL_PUBSUB_TOPIC env var: e.g. "projects/aria-project/topics/aria-gmail-notifications"
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const data = body?.message?.data

    if (!data) {
      // Pub/Sub sends empty pings — acknowledge silently
      return NextResponse.json({ ok: true })
    }

    // Decode base64url -> {emailAddress, historyId}
    const decoded = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf-8')
    )
    const historyId = decoded.historyId
    const emailAddress = decoded.emailAddress

    if (!historyId || !emailAddress) {
      return NextResponse.json({ ok: true })
    }

    // Look up Google-connected users to route the notification
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // For MVP: dispatch for all Google-connected users
    // TODO: Add google_email column to integrations for precise matching
    const { data: integrations } = await supabase
      .from('integrations')
      .select('user_id')
      .eq('platform', 'google')

    if (integrations && integrations.length > 0) {
      const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')

      for (const integration of integrations) {
        const taskId = crypto.randomUUID()
        const taskMessage = JSON.stringify({
          id: taskId,
          task: 'tasks.gmail_process_notification',
          args: [integration.user_id, String(historyId)],
          kwargs: {},
          retries: 0,
        })

        await redis.lpush(
          'celery',
          JSON.stringify({
            'content-type': 'application/json',
            'content-encoding': 'utf-8',
            headers: {
              id: taskId,
              task: 'tasks.gmail_process_notification',
              lang: 'py',
              root_id: taskId,
              parent_id: null,
              group: null,
            },
            properties: {
              correlation_id: taskId,
              reply_to: '',
              delivery_mode: 2,
              delivery_tag: taskId,
              body_encoding: 'utf-8',
            },
            body: Buffer.from(taskMessage).toString('base64'),
          }),
        )
      }

      await redis.quit()
      console.log('[gmail/webhook] dispatched gmail_process_notification for', integrations.length, 'users, historyId:', historyId)
    }
  } catch (e) {
    console.error('[gmail/webhook] error:', e)
  }

  // Always return 200 to acknowledge Pub/Sub delivery
  // Non-200 responses cause Pub/Sub exponential backoff retries
  return NextResponse.json({ ok: true }, { status: 200 })
}
