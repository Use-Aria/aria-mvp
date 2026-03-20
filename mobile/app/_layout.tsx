import { useEffect, useState } from 'react'
import { ActivityIndicator, View, useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { Stack, useRouter, useSegments } from 'expo-router'
import { useSession } from '@/hooks/useSession'
import { ThemeContext, ACCENT_COLORS, COLORS, type AccentColorName } from '@/lib/theme'
import '../global.css'

export default function RootLayout() {
  const { session, loading } = useSession()
  const router = useRouter()
  const segments = useSegments()
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const [accentName, setAccentName] = useState<AccentColorName>('Indigo')

  useEffect(() => {
    if (loading) return
    const inOnboarding = segments[0] === '(onboarding)'
    if (!session && !inOnboarding) {
      router.replace('/(onboarding)/welcome')
    } else if (session && inOnboarding) {
      router.replace('/(home)')
    }
  }, [session, loading, segments])

  if (loading) {
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
