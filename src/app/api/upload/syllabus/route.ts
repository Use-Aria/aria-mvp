import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { enqueueCeleryTask } from '@/lib/celery/enqueue'

/**
 * POST /api/upload/syllabus
 * Accepts a multipart FormData upload of a syllabus PDF and enqueues a
 * Celery parse_syllabus_task via Redis for background Claude Opus parsing.
 *
 * Auth: JWT required (Bearer token from mobile). The user is resolved from the token —
 * never from the request body, so one user can't queue parses into another's account.
 *
 * FormData fields:
 *   - file: PDF file (required, max 4MB)
 *   - course_name: string (required)
 *
 * Returns 202 with taskId on success. PDF bytes are NOT persisted — only
 * the base64-encoded bytes pass through the transient Redis queue.
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 * This route logs only taskId and course_name, no PII.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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
    const userId = user.id

    const formData = await request.formData()

    const file = formData.get('file') as File | null
    const courseName = formData.get('course_name') as string | null

    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!courseName || courseName.trim() === '') {
      return NextResponse.json({ error: 'course_name is required' }, { status: 400 })
    }

    // Validate file size: max 4MB
    const MAX_FILE_SIZE = 4 * 1024 * 1024
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File exceeds 4MB limit' },
        { status: 413 },
      )
    }

    // Convert PDF bytes to base64 — bytes are never persisted
    const arrayBuffer = await file.arrayBuffer()
    const pdfB64 = Buffer.from(arrayBuffer).toString('base64')

    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')

    let taskId: string
    try {
      taskId = await enqueueCeleryTask(redis, 'tasks.parse_syllabus_task', [userId, pdfB64, courseName.trim()])
    } finally {
      await redis.quit()
    }

    console.log('[upload/syllabus] enqueued parse_syllabus_task', taskId, 'for course:', courseName)

    return NextResponse.json({ status: 'queued', taskId }, { status: 202 })
  } catch (err) {
    console.error('[upload/syllabus] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
