import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Redis from 'ioredis'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/onboarding/complete
 * Marks onboarding as complete for the authenticated user and triggers the welcome SMS.
 *
 * Auth: JWT required.
 *
 * Side effects:
 *   1. Sets onboarding_completed_at = now() in users table (idempotent — safe to call twice)
 *   2. Enqueues tasks.welcome_briefing Celery task via Redis
 *
 * Per spec: welcome SMS is decoupled from Canvas sync. This is the only place that
 * fires the welcome briefing. Do NOT re-couple to Canvas sync.
 *
 * Response: { ok: true }
 */
export async function POST(): Promise<NextResponse> {
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

    // --- Set onboarding_completed_at (idempotent) ---
    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { error: updateError } = await adminClient
      .from('users')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', user.id)

    if (updateError) {
      console.error('[onboarding/complete] DB update failed:', updateError.message)
      return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 })
    }

    // --- Enqueue welcome_briefing Celery task via Redis ---
    const taskId = crypto.randomUUID()
    const taskMessage = JSON.stringify({
      id: taskId,
      task: 'tasks.welcome_briefing',
      args: [user.id],
      kwargs: {},
      retries: 0,
    })

    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')

    try {
      await redis.lpush(
        'celery',
        JSON.stringify({
          'content-type': 'application/json',
          'content-encoding': 'utf-8',
          headers: {
            id: taskId,
            task: 'tasks.welcome_briefing',
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
    } finally {
      await redis.quit()
    }

    console.log('[onboarding/complete] onboarding complete, welcome briefing enqueued for user:', user.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[onboarding/complete] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
