import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'

/**
 * POST /api/upload/syllabus
 * Accepts a multipart FormData upload of a syllabus PDF and enqueues a
 * Celery parse_syllabus_task via Redis for background Claude Opus parsing.
 *
 * FormData fields:
 *   - file: PDF file (required, max 4MB)
 *   - course_name: string (required)
 *   - user_id: UUID string (required — Phase 7 bypass; replaced with Supabase session in Phase 8)
 *
 * Returns 202 with taskId on success. PDF bytes are NOT persisted — only
 * the base64-encoded bytes pass through the transient Redis queue.
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 * This route logs only taskId and course_name, no PII.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData()

    const file = formData.get('file') as File | null
    const courseName = formData.get('course_name') as string | null
    const userId = formData.get('user_id') as string | null

    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!courseName || courseName.trim() === '') {
      return NextResponse.json({ error: 'course_name is required' }, { status: 400 })
    }

    if (!userId) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
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

    const taskId = crypto.randomUUID()
    const taskMessage = JSON.stringify({
      id: taskId,
      task: 'tasks.parse_syllabus_task',
      args: [userId, pdfB64, courseName.trim()],
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
          task: 'tasks.parse_syllabus_task',
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

    console.log('[upload/syllabus] enqueued parse_syllabus_task', taskId, 'for course:', courseName)

    return NextResponse.json({ status: 'queued', taskId }, { status: 202 })
  } catch (err) {
    console.error('[upload/syllabus] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
