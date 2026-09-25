import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Redis from 'ioredis'
import { enqueueCeleryTask } from '@/lib/celery/enqueue'

/**
 * POST /api/onboarding/complete
 * Marks onboarding as complete for the authenticated user and triggers the welcome SMS.
 *
 * Auth: JWT required (Bearer token from mobile).
 *
 * Side effects:
 *   1. Sets onboarding_completed_at = now() in users table (idempotent — safe to call twice)
 *   2. Enqueues tasks.welcome_briefing Celery task via Redis (best-effort — failure is logged, not returned)
 *
 * Per spec: welcome SMS is decoupled from Canvas sync. This is the only place that
 * fires the welcome briefing. Do NOT re-couple to Canvas sync.
 *
 * Response: { ok: true }
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // --- Auth (Bearer token from mobile) ---
    const authHeader = request.headers.get('Authorization')
    const jwt = authHeader?.replace('Bearer ', '').trim()
    if (!jwt) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { data: { user }, error: authError } = await adminClient.auth.getUser(jwt)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // --- Set onboarding_completed_at (idempotent) ---
    const { error: updateError } = await adminClient
      .from('users')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', user.id)

    if (updateError) {
      console.error('[onboarding/complete] DB update failed:', updateError.message)
      return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 })
    }

    // --- Enqueue welcome_briefing Celery task via Redis ---
    // Onboarding is already complete in the DB at this point. An enqueue failure must not
    // return an error — the app would show a failure and loop the user back into onboarding.
    // welcome_briefing is idempotent in the worker, so repeat calls don't double-send.
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0', {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    })
    try {
      await enqueueCeleryTask(redis, 'tasks.welcome_briefing', [user.id])
    } catch (enqueueErr) {
      console.error('[onboarding/complete] welcome_briefing enqueue failed:', enqueueErr)
    } finally {
      try { await redis.quit() } catch { /* ignore */ }
    }

    console.log('[onboarding/complete] onboarding complete, welcome briefing enqueued for user:', user.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[onboarding/complete] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
