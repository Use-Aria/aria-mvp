import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'

/**
 * GET /api/auth/google/callback?code=<code>&state=<state>
 * Google OAuth 2.0 callback — exchanges code for tokens and triggers encrypted storage.
 *
 * Security model (per user decision — tokens MUST NOT be stored as plaintext):
 * 1. Validates CSRF state against the oauth_state httpOnly cookie.
 * 2. Exchanges authorization code for access + refresh tokens (Google token endpoint).
 * 3. Dispatches encrypt_and_store_tokens Celery task via Redis.
 *    - Tokens travel as plaintext args ONLY in memory (Next.js process) and
 *      transiently in Redis (in-flight task queue).
 *    - The Celery task encrypts via Fernet BEFORE any Supabase write.
 *    - Tokens are NEVER stored unencrypted in Supabase.
 * 4. Clears the oauth_state cookie.
 * 5. Returns a confirmation HTML page.
 *
 * CLAUDE.md: Google OAuth tokens expire in 1 hour — always refresh before API calls.
 * CLAUDE.md: Store refresh tokens encrypted in Supabase (AES-256 / Fernet).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')
    const stateParam = searchParams.get('state')

    // --- CSRF validation via oauth_state cookie ---
    const oauthStateCookie = request.cookies.get('oauth_state')
    if (!oauthStateCookie?.value) {
      return new NextResponse('Invalid state: missing oauth_state cookie', { status: 403 })
    }

    let storedState: { state: string; user_id: string }
    try {
      storedState = JSON.parse(oauthStateCookie.value)
    } catch {
      return new NextResponse('Invalid state: malformed cookie', { status: 403 })
    }

    if (!stateParam || stateParam !== storedState.state) {
      return new NextResponse('Invalid state: state mismatch (possible CSRF)', { status: 403 })
    }

    if (!code) {
      return new NextResponse('Missing authorization code', { status: 400 })
    }

    const userId = storedState.user_id
    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    const redirectUri = process.env.GOOGLE_REDIRECT_URI

    if (!clientId || !clientSecret || !redirectUri) {
      return NextResponse.json(
        { error: 'Google OAuth environment variables not configured' },
        { status: 500 },
      )
    }

    // --- Exchange authorization code for tokens ---
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text()
      console.error('[auth/google/callback] token exchange failed:', errText)
      return new NextResponse('Token exchange failed', { status: 502 })
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string
      refresh_token?: string
      token_type: string
      expires_in: number
    }

    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token || ''

    // --- Dispatch encrypt_and_store_tokens Celery task via Redis ---
    // Tokens exist only in this process's memory and transiently in Redis.
    // The Celery task encrypts via Fernet BEFORE writing to Supabase.
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')
    const taskId = crypto.randomUUID()
    const taskMessage = JSON.stringify({
      id: taskId,
      task: 'tasks.encrypt_and_store_tokens',
      args: [userId, accessToken, refreshToken],
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
          task: 'tasks.encrypt_and_store_tokens',
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
          priority: 9, // high priority — user is waiting on confirmation SMS
        },
        body: Buffer.from(taskMessage).toString('base64'),
      }),
    )

    await redis.quit()

    // --- Clear oauth_state cookie ---
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Google Connected — Aria</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 60px 20px; color: #111; }
    h1 { font-size: 1.5rem; margin-bottom: 12px; }
    p { color: #555; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Google Connected!</h1>
  <p>You can close this window. Aria will text you shortly.</p>
</body>
</html>`

    const response = new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
    // Clear the oauth_state cookie
    response.cookies.set('oauth_state', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    })

    return response
  } catch (err) {
    console.error('[auth/google/callback] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
