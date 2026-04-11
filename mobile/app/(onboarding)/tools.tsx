import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import * as WebBrowser from 'expo-web-browser'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { api, API_BASE } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'
import CanvasUrlInput from '@/components/onboarding/CanvasUrlInput'

type CanvasStatus = 'idle' | 'validating' | 'valid' | 'error'

/**
 * Onboarding Step 6 — Integration hub.
 *
 * Required section: Gmail + Google Calendar.
 *   All users arrive here via phone auth (no Google session).
 *   "Connect Google" opens the existing /api/auth/google web OAuth flow in a browser.
 *   After the browser closes, we poll the integrations table to confirm Google tokens
 *   were stored by the backend Celery task. Continue is disabled until connected.
 *
 * Optional section:
 *   - Canvas iCal URL: validate via POST /api/sync/canvas.
 *   - Syllabus PDF: file picker → POST /api/upload/syllabus.
 *   - Google Classroom: "Coming soon" badge.
 */
export default function Tools() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [googleConnected, setGoogleConnected] = useState(false)
  const [checkingGoogle, setCheckingGoogle] = useState(true)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleError, setGoogleError] = useState<string | null>(null)

  const [canvasUrl, setCanvasUrl] = useState('')
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>('idle')
  const [canvasError, setCanvasError] = useState<string | undefined>(undefined)

  const [syllabusUploading, setSyllabusUploading] = useState(false)
  const [syllabusFileName, setSyllabusFileName] = useState<string | null>(null)
  const [syllabusError, setSyllabusError] = useState<string | null>(null)

  /**
   * Check integrations table for a google row for this user.
   * Returns true if found.
   */
  const checkGoogleIntegration = useCallback(async (): Promise<boolean> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user?.id) return false
    const { data } = await supabase
      .from('integrations')
      .select('platform')
      .eq('user_id', session.user.id)
      .eq('platform', 'google')
      .maybeSingle()
    return !!data
  }, [])

  // Check on mount whether Google was already connected in a prior session
  useEffect(() => {
    checkGoogleIntegration().then((connected) => {
      setGoogleConnected(connected)
      setCheckingGoogle(false)
    })
  }, [checkGoogleIntegration])

  /**
   * Poll integrations table for up to 12 seconds (8 × 1.5s) after browser closes.
   * The Celery task encrypts and stores tokens asynchronously — we wait for it.
   */
  const pollForGoogleConnection = async (): Promise<boolean> => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const connected = await checkGoogleIntegration()
      if (connected) return true
    }
    return false
  }

  const handleConnectGoogle = async () => {
    if (googleLoading) return
    setGoogleError(null)
    setGoogleLoading(true)

    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) {
      setGoogleError('Session expired. Please restart onboarding.')
      setGoogleLoading(false)
      return
    }

    // Open the existing web-based Google OAuth flow in a browser.
    // The backend route handles CSRF, code exchange, and Fernet-encrypted token storage.
    await WebBrowser.openBrowserAsync(`${API_BASE}/api/auth/google?user_id=${userId}`)

    // Browser closed — poll for the Celery task to write tokens to integrations table
    const connected = await pollForGoogleConnection()
    setGoogleConnected(connected)
    if (!connected) {
      setGoogleError("Couldn't confirm Google connection. Please try again.")
    }
    setGoogleLoading(false)
  }

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

          {checkingGoogle ? (
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
                onPress={handleConnectGoogle}
                disabled={googleLoading}
                style={{
                  backgroundColor: accent,
                  borderRadius: 10,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: googleLoading ? 0.6 : 1,
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
