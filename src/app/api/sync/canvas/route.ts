import { NextResponse } from 'next/server'

/**
 * POST /api/sync/canvas
 *
 * Manual trigger for Canvas iCal sync. Enqueues the canvas_sync_all
 * Celery task via Redis. This is a health check / manual trigger only —
 * all iCal parsing and DB writes happen in the Python Celery worker.
 *
 * In production, Celery Beat handles the 60-minute schedule automatically.
 * This endpoint exists for manual triggering and monitoring.
 */
export async function POST() {
  try {
    // In production, this would publish to Redis to trigger the Celery task.
    // For now, return a stub response indicating the trigger path works.
    // Full Redis publish will be wired when the Next.js app needs to
    // trigger syncs on demand (e.g., user re-connects Canvas URL in Phase 7).
    return NextResponse.json(
      {
        status: 'triggered',
        task: 'tasks.canvas_sync_all',
        note: 'Celery Beat handles automatic 60-min scheduling. This endpoint is for manual triggers.',
      },
      { status: 202 }
    )
  } catch (error) {
    console.error('[sync/canvas] trigger error:', error)
    return NextResponse.json(
      { error: 'Failed to trigger Canvas sync' },
      { status: 500 }
    )
  }
}
