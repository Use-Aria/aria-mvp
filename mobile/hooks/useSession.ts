import { useEffect, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === 'true'

/**
 * Listens to Supabase auth state changes and exposes the current session.
 * Returns { session: Session | null, loading: boolean }.
 * loading is true until the initial getSession() resolves.
 * In demo mode, returns a fake session immediately to skip auth/onboarding.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(
    DEMO_MODE ? ({} as Session) : null
  )
  const [loading, setLoading] = useState(!DEMO_MODE)

  useEffect(() => {
    if (DEMO_MODE) return

    // .catch: a SecureStore/keychain read failure would otherwise leave loading=true forever
    supabase.auth.getSession()
      .then(({ data: { session } }) => setSession(session))
      .catch(() => setSession(null))
      .finally(() => setLoading(false))

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setSession(session)
    )

    return () => subscription.unsubscribe()
  }, [])

  return { session, loading }
}
