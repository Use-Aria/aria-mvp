import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as Crypto from 'expo-crypto'
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'

/**
 * CRITICAL: Must be called at module level (not inside useEffect) to complete
 * the auth session redirect. If called inside a component, OAuth hangs on redirect.
 */
WebBrowser.maybeCompleteAuthSession()

/**
 * Onboarding Step 5 — Google OAuth connection screen.
 *
 * Generates a nonce pair on mount:
 *   - rawNonce: passed to Supabase signInWithIdToken (so Supabase can verify the claim)
 *   - hashedNonce (SHA-256): passed to Google OAuth extraParams (so Google embeds it in the id_token)
 *
 * Google provider_token is intentionally NOT stored client-side.
 * The Supabase session (access_token + refresh_token) is persisted via ExpoSecureStoreAdapter.
 * The backend stores the provider_token server-side via the Supabase auth webhook.
 * Reason: ExpoSecureStore has a 2KB per-key limit — provider_token can exceed this,
 * causing silent storage failures on app re-launch.
 */
export default function GoogleOAuth() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawNonce, setRawNonce] = useState<string>('')
  const [hashedNonce, setHashedNonce] = useState<string>('')

  // Generate nonce pair on mount. Hashed nonce goes to Google; raw nonce goes to Supabase.
  useEffect(() => {
    const generateNonce = async () => {
      const nonce = Crypto.randomUUID()
      setRawNonce(nonce)
      const hashed = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce
      )
      setHashedNonce(hashed)
    }
    generateNonce()
  }, [])

  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    extraParams: hashedNonce ? { nonce: hashedNonce } : undefined,
  })

  // Handle Google OAuth response.
  useEffect(() => {
    if (response?.type === 'success') {
      setLoading(true)
      const { id_token } = response.params
      supabase.auth
        .signInWithIdToken({
          provider: 'google',
          token: id_token,
          nonce: rawNonce, // raw nonce, NOT hashed — Supabase verifies against the hashed value in the id_token
        })
        .then(({ error: authError }) => {
          setLoading(false)
          if (authError) {
            setError("Couldn't connect Google. Try again or skip for now.")
          } else {
            // provider_token intentionally NOT accessed or stored client-side
            router.push('/(onboarding)/tcpa')
          }
        })
    } else if (response?.type === 'error') {
      setError("Couldn't connect Google. Try again or skip for now.")
    }
  }, [response])

  const isReady = !!request && !!hashedNonce

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={5} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        <Text
          style={{
            fontSize: 28,
            fontWeight: '600',
            color: colors.textPrimary,
            marginBottom: 12,
          }}
        >
          Connect Google
        </Text>
        <Text
          style={{
            fontSize: 16,
            color: colors.textSecondary,
            lineHeight: 24,
          }}
        >
          Link your Google account to sync your calendar and catch professor email updates.
        </Text>

        {error ? (
          <Text
            style={{
              color: '#FF3B30',
              fontSize: 14,
              marginTop: 16,
            }}
          >
            {error}
          </Text>
        ) : null}
      </View>

      {/* Bottom CTA section */}
      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: 32,
          gap: 16,
        }}
      >
        {/* Primary CTA: Connect Google */}
        <TouchableOpacity
          onPress={() => promptAsync()}
          disabled={!isReady || loading}
          style={{
            backgroundColor: accent,
            borderRadius: 12,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !isReady || loading ? 0.6 : 1,
          }}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
              Connect Google
            </Text>
          )}
        </TouchableOpacity>

        {/* Secondary CTA: Skip for now */}
        <TouchableOpacity
          onPress={() => router.push('/(onboarding)/tcpa')}
          style={{
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: accent, fontSize: 16, fontWeight: '400' }}>
            Skip for now -&gt;
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}
