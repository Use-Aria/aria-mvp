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
import * as WebBrowser from 'expo-web-browser'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { api, API_BASE } from '@/lib/api'
import { canvasDomainForUniversity } from '@/lib/universities'
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
 *   - Todoist, iOS Reminders, Google Classroom: "Coming soon" badges (not yet implemented).
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

  const [university, setUniversity] = useState<string | null>(null)

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

  // Check on mount whether Google was already connected, and restore Canvas URL
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (!active) return
      checkGoogleIntegration().then((connected) => {
        if (!active) return
        setGoogleConnected(connected)
        setCheckingGoogle(false)
      })
      ;(async () => {
        const { data: { session } } = await supabase.auth.getSession()
        if (!active || !session?.user?.id) return
        const { data } = await supabase
          .from('integrations')
          .select('ical_url')
          .eq('user_id', session.user.id)
          .eq('platform', 'canvas')
          .maybeSingle()
        if (active && data?.ical_url) {
          setCanvasUrl(data.ical_url)
          setCanvasStatus('valid')
        }
      })()
      ;(async () => {
        const { data: { session } } = await supabase.auth.getSession()
        if (!active || !session?.user?.id) return
        const { data } = await supabase
          .from('users')
          .select('university')
          .eq('id', session.user.id)
          .maybeSingle()
        if (active && data?.university) setUniversity(data.university)
      })()
    }, 0)

    return () => { active = false; clearTimeout(timer) }
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

  const handleCanvasValidate = () => {
    setCanvasError(undefined)
    const CANVAS_URL_REGEX = /^(webcal|https?):\/\/.*/
    if (!CANVAS_URL_REGEX.test(canvasUrl.trim())) {
      setCanvasStatus('error')
      setCanvasError("Doesn't look like a Canvas iCal URL. Should start with webcal:// or https://")
      return
    }
    setCanvasStatus('validating')
    void (async () => {
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
    })()
  }

  /**
   * Derives the Canvas base URL to open, in priority order:
   * 1. Domain extracted from a typed/pasted iCal URL
   * 2. Domain from university lookup (fetched from user profile)
   * 3. null → button disabled (unknown school, no URL typed)
   */
  const resolvedCanvasDomain = (() => {
    try {
      if (canvasUrl) return new URL(canvasUrl).origin
    } catch {}
    return canvasDomainForUniversity(university)
  })()

  const handleOpenCanvas = async () => {
    if (!resolvedCanvasDomain) return
    await WebBrowser.openBrowserAsync(`${resolvedCanvasDomain}/calendar`)
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={6} />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity onPress={() => router.replace('/(onboarding)/tcpa')} style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 16, color: accent }}>← Back</Text>
        </TouchableOpacity>
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
          {canvasStatus !== 'valid' && (
            <View style={{ marginBottom: 16 }}>
              {[
                'Step 1: Tap "Open Canvas" below',
                'Step 2: Scroll down to "Calendar Feed" and tap it — a card appears with your iCal URL',
                'Step 3: Copy the URL, come back here, and paste it below',
              ].map((step) => (
                <View key={step} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 20 }}>
                    {step}
                  </Text>
                </View>
              ))}

              <TouchableOpacity
                onPress={handleOpenCanvas}
                disabled={!resolvedCanvasDomain}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: resolvedCanvasDomain ? accent : colors.cardBorder,
                  borderRadius: 10,
                  height: 40,
                  marginTop: 10,
                  gap: 6,
                  opacity: resolvedCanvasDomain ? 1 : 0.4,
                }}
              >
                <Ionicons name="open-outline" size={16} color={resolvedCanvasDomain ? accent : colors.textSecondary} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: resolvedCanvasDomain ? accent : colors.textSecondary }}>
                  Open Canvas
                </Text>
              </TouchableOpacity>
              {!resolvedCanvasDomain && (
                <Text style={{ fontSize: 12, color: colors.textSecondary, textAlign: 'center', marginTop: 6 }}>
                  Paste your Canvas URL above to activate this button
                </Text>
              )}

              <View style={{ height: 1, backgroundColor: colors.cardBorder, marginVertical: 16 }} />
            </View>
          )}
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

        {/* Coming soon cards */}
        {[
          {
            icon: 'checkmark-done-outline' as const,
            title: 'Todoist',
            description: 'Sync your tasks and to-dos with Aria',
          },
          {
            icon: 'list-outline' as const,
            title: 'Reminders',
            description: 'Bring your iOS Reminders into your daily briefing',
          },
          {
            icon: 'library-outline' as const,
            title: 'Google Classroom',
            description: 'Assignment sync from Google Classroom',
          },
        ].map((item) => (
          <View key={item.title} style={{
            borderWidth: 1,
            borderColor: colors.cardBorder,
            borderRadius: 16,
            padding: 20,
            marginBottom: 16,
            backgroundColor: colors.secondary,
            opacity: 0.5,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name={item.icon} size={22} color={colors.textPrimary} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                    {item.title}
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
                  {item.description}
                </Text>
              </View>
            </View>
          </View>
        ))}

        <View style={{ marginBottom: 16 }} />

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
