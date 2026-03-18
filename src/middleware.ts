import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Supabase Auth token refresh middleware.
 * Intercepts every non-static request, refreshes the auth token if expired,
 * and writes the updated token back to cookies. This is required for AUTH-04:
 * sessions must survive browser hard-refresh.
 *
 * IMPORTANT: uses getClaims() — never getSession() on the server.
 * getSession() does not revalidate tokens server-side and is a security anti-pattern.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getClaims() refreshes the auth token and writes it back to cookies.
  // Without this call, sessions die on browser refresh.
  await supabase.auth.getClaims()

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
