import { createBrowserClient } from '@supabase/ssr'

/**
 * Creates a Supabase client for use in browser (client) components.
 * Uses NEXT_PUBLIC_ env vars which are safe to expose client-side.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
