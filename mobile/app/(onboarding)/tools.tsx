import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as Crypto from 'expo-crypto'
import * as DocumentPicker from 'expo-document-picker'
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { api } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'
import CanvasUrlInput from '@/components/onboarding/CanvasUrlInput'

WebBrowser.maybeCompleteAuthSession()

type CanvasStatus = 'idle' | 'validating' | 'valid' | 'error'

/**
 * Onboarding Step 6 — Integration hub.
 *
 * Required section: Gmail + Google Calendar.
 *   - If user signed in with Google (provider === 'google'): show "Connected ✓" — no action needed.
 *   - If user signed in with Apple: show "Connect Google" button. Re-triggers Google OAuth
 *     with calendar + gmail.readonly scopes. Continue is disabled until connected.
 *
 * Optional section:
 *   - Canvas iCal URL: validate via POST /api/sync/canvas (reuses CanvasUrlInput component).
 *   - Syllabus PDF: file picker per course via expo-document-picker → POST /api/upload/syllabus.
 *   - Google Classroom: "Coming soon" badge.
 *
 * User can skip all optional items and tap Continue once Google is connected.
 */
export default function Tools() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [googleConnected, setGoogleConnected] = useState(false)
  const [checkingProvider, setCheckingProvider] = useState(true)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleError, setGoogleError] = useState<string | null>(null)

  const [canvasUrl, setCanvasUrl] = useState('')
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>('idle')
  const [canvasError, setCanvasError] = useState<string | undefined>(undefined)

  const [syllabusUploading, setSyllabusUploading] = useState(false)
  const [syllabusFileName, setSyllabusFileName] = useState<string | null>(null)
  const [syllabusError, setSyllabusError] = useState<string | null>(null)

  const [rawNonce, setRawNonce] = useState('')
  const [hashedNonce, setHashedNonce] = useState('')

  // Generate nonce pair for Google OAuth (only needed for Apple-auth users)
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

  // Detect auth provider from session
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const provider = session?.user?.app_metadata?.provider as string | undefined
      setGoogleConnected(provider === 'google')
      setCheckingProvider(false)
    })
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

  // Handle Google OAuth response (for Apple-auth users connecting Google)
  useEffect(() => {
    if (response?.type === 'success') {
      setGoogleLoading(true)
      const { id_token } = response.params
      supabase.auth
        .signInWithIdToken({
          provider: 'google',
          token: id_token,
          nonce: rawNonce,
        })
        .then(({ error: authError }) => {
          setGoogleLoading(false)
          if (authError) {
            setGoogleError("Couldn't connect Google. Please try again.")
          } else {
            setGoogleConnected(true)
            setGoogleError(null)
          }
        })
    } else if (response?.type === 'error') {
      setGoogleError("Couldn't connect Google. Please try again.")
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response])

  const handleCanvasValidate = async () => {
    setCanvasError(undefined)
    const CANVAS_URL_REGEX = /^(webcal|https?):\/\/.*/
    if (!CANVAS_URL_REGEX.test(canvasUrl.trim())) {
      setCanvasStatus('error')
      setCanvasError("Doesn't look like a Canvas iCal URL. Should start with webcal:// or https://")
      return
    }
    setCanvasStatus('validating')
    try {
      const result = await api.validateCanvasUrl(canvasUrl.trim())
      if (result?.deadline_count === 0) {
        setCanvasStatus('error')
        setCanvasError('URL connected but no deadlines found. Check your Canvas calendar has events.')
        return
      }
      setCanvasStatus('valid')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      setCanvasStatus('error')
      setCanvasError(
        message.includes('400')
          ? "That doesn't look like a Canvas iCal URL."
          : "Couldn't reach that Canvas feed. Double-check the URL."
      )
    }
  }

  const handleSyllabusPick = async () => {
    setSyllabusError(null)
    setSyllabusUploading(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
      })
      if (result.canceled || !result.assets?.[0]) {
        setSyllabusUploading(false)
        return
      }
      const asset = result.assets[0]
      const courseName = asset.name.replace(/\.pdf$/i, '')
      await api.uploadSyllabus(asset.uri, courseName)
      setSyllabusFileName(asset.name)
    } catch {
      setSyllabusError("Couldn't upload syllabus. Please try again.")
    } finally {
      setSyllabusUploading(false)
    }
  }

  const isGoogleReady = !!request && !!hashedNonce

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={6} />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
          Connect your tools
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 32 }}>
          Aria needs Google to sync your calendar and watch professor emails.
        </Text>

        {/* ── Required section ── */}
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 1, marginBottom: 12 }}>
          REQUIRED
        </Text>

        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 24,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="logo-google" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Gmail + Google Calendar
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Deadline alerts and calendar sync
              </Text>
            </View>
          </View>

          {checkingProvider ? (
            <ActivityIndicator color={accent} />
          ) : googleConnected ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle" size={20} color="#34C759" />
              <Text style={{ fontSize: 15, color: '#34C759', fontWeight: '600' }}>Connected</Text>
            </View>
          ) : (
            <>
              {googleError ? (
                <Text style={{ color: '#FF3B30', fontSize: 14, marginBottom: 10 }}>{googleError}</Text>
              ) : null}
              <TouchableOpacity
                onPress={() => { setGoogleError(null); promptAsync() }}
                disabled={!isGoogleReady || googleLoading}
                style={{
                  backgroundColor: accent,
                  borderRadius: 10,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: !isGoogleReady || googleLoading ? 0.6 : 1,
                }}
              >
                {googleLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
                    Connect Google
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ── Optional section ── */}
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 1, marginBottom: 12 }}>
          OPTIONAL
        </Text>

        {/* Canvas */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 16,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <Ionicons name="school-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Canvas
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Import deadlines from your iCal feed
              </Text>
            </View>
          </View>
          <CanvasUrlInput
            value={canvasUrl}
            onChangeText={(text) => {
              setCanvasUrl(text)
              if (canvasStatus !== 'idle') setCanvasStatus('idle')
            }}
            onValidate={handleCanvasValidate}
            status={canvasStatus}
            errorMessage={canvasError}
          />
        </View>

        {/* Syllabus */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 16,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <Ionicons name="document-text-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Syllabus
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Upload a PDF so Aria knows your grade weights
              </Text>
            </View>
          </View>

          {syllabusFileName ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle" size={20} color="#34C759" />
              <Text style={{ fontSize: 14, color: '#34C759', fontWeight: '600', flex: 1 }} numberOfLines={1}>
                {syllabusFileName}
              </Text>
            </View>
          ) : (
            <>
              {syllabusError ? (
                <Text style={{ color: '#FF3B30', fontSize: 14, marginBottom: 8 }}>{syllabusError}</Text>
              ) : null}
              <TouchableOpacity
                onPress={handleSyllabusPick}
                disabled={syllabusUploading}
                style={{
                  borderWidth: 1,
                  borderColor: accent,
                  borderRadius: 10,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: syllabusUploading ? 0.6 : 1,
                }}
              >
                {syllabusUploading ? (
                  <ActivityIndicator color={accent} />
                ) : (
                  <Text style={{ color: accent, fontSize: 15, fontWeight: '600' }}>
                    Choose PDF
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Google Classroom — coming soon */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 32,
          backgroundColor: colors.secondary,
          opacity: 0.6,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="library-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                  Google Classroom
                </Text>
                <View style={{
                  backgroundColor: `${accent}20`,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: accent }}>COMING SOON</Text>
                </View>
              </View>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Assignment sync from Google Classroom
              </Text>
            </View>
          </View>
        </View>

        {/* Continue CTA */}
        <TouchableOpacity
          onPress={() => router.push('/(onboarding)/success')}
          disabled={!googleConnected}
          style={{
            backgroundColor: accent,
            borderRadius: 12,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: googleConnected ? 1 : 0.4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
            Continue
          </Text>
        </TouchableOpacity>

        {!googleConnected ? (
          <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 10 }}>
            Connect Google to continue
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}
