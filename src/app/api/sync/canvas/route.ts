import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/sync/canvas
 * Validates a Canvas iCal URL during onboarding by fetching the feed,
 * counting VEVENT entries, and extracting sample course names.
 *
 * Auth: JWT required.
 *
 * Request:  { ical_url: string }
 * Response: { deadline_count: number; sample_courses: string[] }
 *
 * Error codes:
 *   400 — missing/malformed URL (not a valid Canvas iCal URL)
 *   401 — not authenticated
 *   408 — fetch timed out (10s limit)
 *   422 — URL is valid but feed contains no VEVENT entries
 *   500 — unexpected error
 *
 * CLAUDE.md: Canvas iCal rate limit is 120 req/min — this endpoint is called once
 * per onboarding session, never polled automatically.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // --- Auth: resolve user from Bearer token (mobile app sends JWT in Authorization header) ---
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

    // --- Parse body ---
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { ical_url } = body as Record<string, unknown>

    if (typeof ical_url !== 'string' || ical_url.trim().length === 0) {
      return NextResponse.json({ error: 'ical_url is required' }, { status: 400 })
    }

    // --- Validate URL shape before fetching ---
    // Canvas sometimes emits webcal:// scheme links — normalize to https:// before parsing.
    // Node's URL constructor does not recognise webcal as a valid WHATWG scheme and will throw.
    const normalizedUrl = ical_url.trim().replace(/^webcal:\/\//i, 'https://')
    let parsedUrl: URL
    try {
      parsedUrl = new URL(normalizedUrl)
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
    }

    // Canvas iCal URLs always end in .ics and contain a feed token
    if (!parsedUrl.pathname.endsWith('.ics')) {
      return NextResponse.json(
        { error: 'URL does not look like a Canvas iCal feed (must end in .ics)' },
        { status: 400 },
      )
    }

    // --- Fetch the iCal feed with a 10-second timeout ---
    let icalText: string
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const fetchResponse = await fetch(parsedUrl.toString(), {
        signal: controller.signal,
        headers: { 'User-Agent': 'Aria/1.0 iCal Validator' },
      })
      clearTimeout(timeout)

      if (!fetchResponse.ok) {
        return NextResponse.json(
          { error: `Canvas feed returned HTTP ${fetchResponse.status}` },
          { status: 400 },
        )
      }

      icalText = await fetchResponse.text()
    } catch (fetchErr: unknown) {
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        return NextResponse.json({ error: 'Canvas feed fetch timed out' }, { status: 408 })
      }
      console.error('[sync/canvas] fetch error:', fetchErr)
      return NextResponse.json({ error: 'Failed to fetch Canvas feed' }, { status: 400 })
    }

    // --- Parse VEVENT blocks ---
    // iCal spec: each event starts with BEGIN:VEVENT and ends with END:VEVENT
    const eventBlocks = icalText.split('BEGIN:VEVENT').slice(1) // first segment is calendar header

    const deadlineCount = eventBlocks.length

    if (deadlineCount === 0) {
      return NextResponse.json(
        { error: 'Canvas feed is empty — no deadlines found' },
        { status: 422 },
      )
    }

    // --- Extract course names from SUMMARY lines ---
    // Canvas SUMMARY format: "Assignment Title [COURSE 101]" or "Assignment Title (Course Name)"
    const courseSet = new Set<string>()

    for (const block of eventBlocks) {
      // Extract SUMMARY value, handling RFC 5545 line folding (continuation lines start with space/tab)
      const lines = block.split(/\r?\n/)
      const summaryParts: string[] = []
      let inSummary = false

      for (const line of lines) {
        if (line.startsWith('SUMMARY:')) {
          inSummary = true
          summaryParts.push(line.slice('SUMMARY:'.length))
        } else if (inSummary && (line.startsWith(' ') || line.startsWith('\t'))) {
          summaryParts.push(line.slice(1))
        } else if (inSummary) {
          break
        }
      }

      if (summaryParts.length === 0) continue
      const summary = summaryParts.join('').trim()

      // Try bracket notation: "Title [COURSE 101]"
      const bracketMatch = summary.match(/\[([^\]]+)\]/)
      if (bracketMatch) {
        courseSet.add(bracketMatch[1].trim())
        continue
      }

      // Try paren notation: "Title (Course Name)"
      const parenMatch = summary.match(/\(([^)]+)\)$/)
      if (parenMatch) {
        courseSet.add(parenMatch[1].trim())
      }
    }

    const sampleCourses = Array.from(courseSet).slice(0, 5)

    // --- Persist the validated iCal URL to the integrations table ---
    const { error: upsertError } = await adminClient
      .from('integrations')
      .upsert(
        { user_id: user.id, platform: 'canvas', ical_url: parsedUrl.toString() },
        { onConflict: 'user_id,platform' },
      )

    if (upsertError) {
      console.error('[sync/canvas] failed to save ical_url:', upsertError.message)
      // Non-fatal — validation succeeded, return results anyway
    }

    console.log('[sync/canvas] validated feed for user:', user.id, '— events:', deadlineCount)

    return NextResponse.json({ deadline_count: deadlineCount, sample_courses: sampleCourses })
  } catch (err) {
    console.error('[sync/canvas] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
