import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/auth/todoist/callback
 *
 * Todoist OAuth callback route. Exchanges the authorization code for an access
 * token and stores it in the integrations table, then redirects to the app's
 * deep link so WebBrowser.openAuthSessionAsync resolves in the iOS client.
 *
 * @param req - NextRequest containing `code` (auth code) and `state` (user_id) as query params
 * @returns Redirect to aria://todoist-connected on success, JSON error on failure
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const userId = req.nextUrl.searchParams.get('state') // user_id passed as OAuth state param

  if (!code || !userId) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 })
  }

  // Exchange authorization code for access token
  const tokenRes = await fetch('https://api.todoist.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.TODOIST_CLIENT_ID!,
      client_secret: process.env.TODOIST_CLIENT_SECRET!,
      code,
      // Must match the authorize request, which the app builds from its API base (this host).
      // NEXT_PUBLIC_APP_URL was never defined anywhere, which produced 'undefined/api/...'.
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/api/auth/todoist/callback`,
    }),
  })

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text()
    console.error('[todoist-callback] token exchange failed:', tokenRes.status, errBody)
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 500 })
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string }

  // Store in integrations table (upsert on user_id + platform)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await supabase.from('integrations').upsert(
    {
      user_id: userId,
      platform: 'todoist',
      access_token,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,platform' }
  )

  if (error) {
    console.error('[todoist-callback] supabase upsert failed:', error)
    return NextResponse.json({ error: 'Failed to store token' }, { status: 500 })
  }

  // Redirect to app deep link so WebBrowser.openAuthSessionAsync resolves
  return NextResponse.redirect('aria://todoist-connected')
}
