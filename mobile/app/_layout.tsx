import 'react-native-url-polyfill/auto'
import { useEffect, useState } from 'react'
import { ActivityIndicator, View, useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { Stack, useRouter, useSegments } from 'expo-router'
import { useSession } from '@/hooks/useSession'
import { supabase } from '@/lib/supabase'
import { ThemeContext, ACCENT_COLORS, COLORS, type AccentColorName } from '@/lib/theme'
import '../global.css'

const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === 'true'

export default function RootLayout() {
  const { session, loading } = useSession()
  const router = useRouter()
  const segments = useSegments()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const [accentName, setAccentName] = useState<AccentColorName>('Green')
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)

  // Fetch onboarding completion status when session or top-level segment changes.
  // Reset to null before fetching so the routing guard (onboardingDone === null → return)
  // blocks any redirect until the fresh value arrives — prevents the race where
  // routing fires with stale onboardingDone=false right as the user leaves the success screen.
  useEffect(() => {
    if (!session) { setOnboardingDone(null); return }
    // Demo mode uses a stub session with no user — skip the DB check entirely.
    if (DEMO_MODE || !session.user?.id) { setOnboardingDone(true); return }
    const userId = session.user.id
    setOnboardingDone(null)

    // A failed query (network/RLS) must not be read as "not onboarded" — that would bounce
    // a fully onboarded user into onboarding. Keep the value null (guard blocks redirects)
    // and retry with capped backoff. PGRST116 = no row yet, which genuinely means not done.
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const check = async (attempt: number) => {
      const { data, error } = await supabase
        .from('users')
        .select('onboarding_completed_at')
        .eq('id', userId)
        .single()
      if (!active) return
      if (error && error.code !== 'PGRST116') {
        retryTimer = setTimeout(() => check(attempt + 1), Math.min(1000 * 2 ** attempt, 8000))
        return
      }
      setOnboardingDone(!!data?.onboarding_completed_at)
    }
    check(0)
    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [session?.user?.id, segments[0]])

  useEffect(() => {
    if (loading) return
    if (session && onboardingDone === null) return // still checking
    const inOnboarding = segments[0] === '(onboarding)'
    if (!session && !inOnboarding) {
      router.replace('/(onboarding)/welcome')
    } else if (session && onboardingDone && inOnboarding) {
      router.replace('/(home)')
    } else if (session && !onboardingDone && !inOnboarding) {
      router.replace('/(onboarding)/profile')
    }
  }, [session, loading, segments, onboardingDone])

  // Only block rendering while we don't yet know where to route the user.
  // Once the user has reached (home), skip the spinner — the Stack stays mounted
  // and the home screen renders immediately. The routing guard (onboardingDone === null → return)
  // already prevents any wrong redirect while the re-fetch is in flight.
  const alreadyInHome = segments[0] === '(home)'
  if (loading || (session && onboardingDone === null && !alreadyInHome)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeContext.Provider
        value={{
          accent: ACCENT_COLORS[accentName],
          accentName,
          setAccent: setAccentName,
          colors: isDark ? COLORS.dark : COLORS.light,
          isDark,
        }}
      >
        <BottomSheetModalProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(home)" />
          </Stack>
        </BottomSheetModalProvider>
      </ThemeContext.Provider>
    </GestureHandlerRootView>
  )
}
