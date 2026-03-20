import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'

/**
 * POST /api/gcal/webhook
 * Google Calendar push notification receiver — Phase 6 implementation.
 *
 * GCal sends push notifications to this URL when calendar events change.
 * The user_id is embedded in the X-Goog-Channel-Token header (set during
 * watch channel setup in establish_watch).
 *
 * Protocol:
 * 1. Acknowledge the initial 'sync' handshake immediately with 200.
 * 2. For 'exists' (change) notifications, enqueue gcal_sync_user via Redis.
 * 3. Always return 200 immediately — GCal retries on non-200 responses.
 *
 * Security: GCal sends X-Goog-Channel-Token as the user_id (UUID). This is
 * not a secret — it only routes the task to the correct user. The actual
 * data fetch is protected by OAuth tokens stored in Supabase.
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 * GCal webhook logs only channel metadata (no PII).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const channelToken = request.headers.get('x-goog-channel-token') // user_id
    const resourceState = request.headers.get('x-goog-resource-state')
    const channelId = request.headers.get('x-goog-channel-id')

    // Initial sync handshake — GCal sends 'sync' on channel registration.
    // Acknowledge immediately with 200, no work needed.
    if (resourceState === 'sync') {
      console.log('[gcal/webhook] sync handshake for channel', channelId)
      return NextResponse.json({ ok: true }, { status: 200 })
    }

    // For 'exists' or other change notifications, enqueue gcal_sync_user.
    // channelToken is the user_id set in establish_watch() body.token.
    if (channelToken) {
      const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')

      const taskId = crypto.randomUUID()
      const taskMessage = JSON.stringify({
        id: taskId,
        task: 'tasks.gcal_sync_user',
        args: [channelToken], // user_id
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
            task: 'tasks.gcal_sync_user',
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

      await redis.quit()

      console.log('[gcal/webhook] enqueued gcal_sync_user for channel', channelId)
    } else {
      // No token means we can't identify the user — log and return 200.
      // Do not return non-200 or GCal will retry exponentially.
      console.warn('[gcal/webhook] missing x-goog-channel-token, resourceState:', resourceState)
    }

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error('[gcal/webhook] error:', err)
    // Always return 200 to prevent GCal from retrying with exponential backoff.
    return NextResponse.json({ ok: true }, { status: 200 })
  }
}
