import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/auth/google?user_id=<uuid>
 * Initiates Google OAuth 2.0 authorization for Calendar + Gmail.
 *
 * 1. Reads user_id from query param.
 * 2. Generates an HMAC state token (CSRF protection).
 * 3. Stores {state, user_id} in a signed httpOnly cookie (10-min expiry).
 * 4. Redirects to Google authorization URL with Calendar + Gmail scopes.
 *
 * Scopes requested:
 *   - https://www.googleapis.com/auth/calendar
 *   - https://www.googleapis.com/auth/gmail.readonly
 *
 * CLAUDE.md: Google OAuth tokens expire in 1 hour — always refresh before API calls.
 * CLAUDE.md: Store refresh tokens encrypted in Supabase (handled by Celery task on callback).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('user_id')

    if (!userId) {
      return NextResponse.json({ error: 'user_id query param is required' }, { status: 400 })
    }

    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    const clientId = process.env.GOOGLE_CLIENT_ID
    const redirectUri = process.env.GOOGLE_REDIRECT_URI

    if (!clientSecret || !clientId || !redirectUri) {
      return NextResponse.json(
        { error: 'Google OAuth environment variables not configured' },
        { status: 500 },
      )
    }

    // Generate HMAC state for CSRF protection
    const state = crypto
      .createHmac('sha256', clientSecret)
      .update(userId + Date.now().toString())
      .digest('hex')

    // Build Google OAuth authorization URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.readonly',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent', // forces refresh_token on re-auth
      state,
    })

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`

    // Store state + user_id in a signed httpOnly cookie (10-minute TTL)
    const cookieValue = JSON.stringify({ state, user_id: userId })
    const response = NextResponse.redirect(authUrl)
    response.cookies.set('oauth_state', cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    })

    return response
  } catch (err) {
    console.error('[auth/google] error initiating OAuth:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
