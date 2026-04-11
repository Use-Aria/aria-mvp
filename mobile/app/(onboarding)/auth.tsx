import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/**
 * CRITICAL: Must be called at module level (not inside useEffect) to complete
 * the auth session redirect. If called inside a component, OAuth hangs on redirect.
 */
WebBrowser.maybeCompleteAuthSession()

/**
 * Onboarding Step 2 — Authentication screen.
 *
 * Two paths:
 *   Apple Sign-In: uses expo-apple-authentication + Supabase signInWithIdToken.
 *     Does NOT grant Google scopes — user will be prompted in tools screen.
 *   Google OAuth: uses expo-auth-session with calendar + gmail.readonly scopes.
 *     Nonce pair generated on mount (hashedNonce → Google, rawNonce → Supabase).
 *
 * On success (either path): navigate to profile screen.
 *
 * Note: Apple Sign-In button only renders on iOS — platform guard prevents
 * rendering on Android/web where the API is unavailable.
 */
export default function Auth() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawNonce, setRawNonce] = useState('')
  const [hashedNonce, setHashedNonce] = useState('')

  // Generate nonce pair on mount for Google OAuth nonce flow
  useEffect(() => {
    const generate = async () => {
      const nonce = Crypto.randomUUID()
      setRawNonce(nonce)
      const hashed = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce,
      )
      setHashedNonce(hashed)
    }
    generate()
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

  // Handle Google OAuth response
  useEffect(() => {
    if (response?.type === 'success') {
      setLoading(true)
      const { id_token } = response.params
      supabase.auth
        .signInWithIdToken({
          provider: 'google',
          token: id_token,
          nonce: rawNonce,
        })
        .then(({ error: authError }) => {
          setLoading(false)
          if (authError) {
            setError("Couldn't sign in with Google. Please try again.")
          } else {
            router.push('/(onboarding)/profile')
          }
        })
    } else if (response?.type === 'error') {
      setError("Couldn't sign in with Google. Please try again.")
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response])

  const handleAppleSignIn = async () => {
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const nonce = Crypto.randomUUID()
      const hashedAppleNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce,
      )
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedAppleNonce,
      })

      const { error: authError } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken!,
        nonce,
      })

      if (authError) {
        setError("Couldn't sign in with Apple. Please try again.")
      } else {
        router.push('/(onboarding)/profile')
      }
    } catch (err: unknown) {
      // ERR_CANCELED is thrown when user dismisses the sheet — not an error
      if (err instanceof Error && err.message.includes('ERR_CANCELED')) {
        // do nothing
      } else {
        setError("Couldn't sign in with Apple. Please try again.")
      }
    } finally {
      setLoading(false)
    }
  }

  const isGoogleReady = !!request && !!hashedNonce

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <View style={{ flex: 1, paddingHorizontal: 28, justifyContent: 'center' }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: accent, letterSpacing: 1.2, marginBottom: 10 }}>
          ARIA · AI PERSONAL ASSISTANT
        </Text>
        <Text style={{ fontSize: 34, fontWeight: '800', color: colors.textPrimary, lineHeight: 40, marginBottom: 12 }}>
          Create your account
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 48 }}>
          Sign in to connect your calendar, Gmail, and Canvas in one step.
        </Text>

        {error ? (
          <Text style={{ color: '#FF3B30', fontSize: 14, marginBottom: 16, textAlign: 'center' }}>
            {error}
          </Text>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: 28, paddingBottom: 48, gap: 14 }}>
        {/* Google Sign-In */}
        <TouchableOpacity
          onPress={() => { setError(null); promptAsync() }}
          disabled={!isGoogleReady || loading}
          style={{
            backgroundColor: accent,
            borderRadius: 14,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !isGoogleReady || loading ? 0.6 : 1,
          }}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#FFFFFF' }}>
              Sign in with Google
            </Text>
          )}
        </TouchableOpacity>

        {/* Apple Sign-In — iOS only */}
        {Platform.OS === 'ios' ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={14}
            style={{ height: 56 }}
            onPress={handleAppleSignIn}
          />
        ) : null}

        <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>
          Yale students only · Closed beta
        </Text>
      </View>
    </SafeAreaView>
  )
}
