import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as WebBrowser from 'expo-web-browser'
import { useTheme, ACCENT_COLORS, AccentColorName } from '@/lib/theme'
// Accent color presets: Indigo | Blue | Green | Orange | Pink | Purple
import { supabase } from '@/lib/supabase'

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

type Integration = {
  platform: string
  connected_at: string | null
  synced_at: string | null
}

type Syllabus = {
  id: string
  course_name: string
  uploaded_at: string
}

type HiddenCard = {
  id: string
  title: string
}

/**
 * Determine integration health based on synced_at timestamp.
 * green = synced within 2 hours, yellow = within 24 hours, red = older or never
 */
function getHealthColor(synced_at: string | null): { dot: string; label: string } {
  if (!synced_at) return { dot: '#8E8E93', label: 'Not connected' }
  const diff = Date.now() - new Date(synced_at).getTime()
  const hours = diff / (1000 * 60 * 60)
  if (hours <= 2) return { dot: '#34C759', label: 'Connected' }
  if (hours <= 24) return { dot: '#FF9500', label: 'Connected' }
  return { dot: '#FF3B30', label: 'Connected' }
}

/**
 * Preferences screen — covers UI-02 (syllabus upload), UI-03 (preferences), UI-04 (integrations).
 *
 * Sections:
 * 1. Accent Color — 6 swatches, persisted to users.preferences_json
 * 2. Connected Accounts — Canvas and Google status from integrations table
 * 3. Syllabi — upload PDF via document picker, list existing
 * 4. Quiet Hours — SMS quiet window configuration
 * 5. Hidden Cards — restore hidden cards
 */
export default function Preferences() {
  const { colors, accent, accentName, setAccent } = useTheme()
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [syllabi, setSyllabi] = useState<Syllabus[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<string | null>(null)
  const [hiddenCards, setHiddenCards] = useState<HiddenCard[]>([])
  const [quietStart, setQuietStart] = useState('22:00')
  const [quietEnd, setQuietEnd] = useState('08:00')
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const [integrationsRes, syllabiRes, userRes] = await Promise.all([
        supabase
          .from('integrations')
          .select('platform, connected_at, synced_at')
          .eq('user_id', session.user.id),
        supabase
          .from('syllabi')
          .select('id, course_name, uploaded_at')
          .eq('user_id', session.user.id)
          .order('uploaded_at', { ascending: false }),
        supabase
          .from('users')
          .select('preferences_json')
          .eq('id', session.user.id)
          .single(),
      ])

      if (integrationsRes.data) setIntegrations(integrationsRes.data)
      if (syllabiRes.data) setSyllabi(syllabiRes.data)

      if (userRes.data?.preferences_json) {
        const prefs = userRes.data.preferences_json as {
          quiet_hours_start?: string
          quiet_hours_end?: string
          hidden_cards?: HiddenCard[]
        }
        if (prefs.quiet_hours_start) setQuietStart(prefs.quiet_hours_start)
        if (prefs.quiet_hours_end) setQuietEnd(prefs.quiet_hours_end)
        if (prefs.hidden_cards) setHiddenCards(prefs.hidden_cards)
      }
    } catch {
      // Non-blocking — show with empty defaults
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  /** Persist accent color selection to Supabase and update theme context */
  const handleAccentSelect = useCallback(async (colorName: AccentColorName) => {
    setAccent(colorName)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const { data: user } = await supabase
        .from('users')
        .select('preferences_json')
        .eq('id', session.user.id)
        .single()
      await supabase
        .from('users')
        .update({
          preferences_json: {
            ...(user?.preferences_json ?? {}),
            accent_color: colorName,
          },
        })
        .eq('id', session.user.id)
    } catch {
      // Non-blocking — local theme already applied
    }
  }, [setAccent])

  /** Upload a PDF syllabus to the API */
  const pickSyllabus = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf' })
      if (result.canceled) return

      const file = result.assets[0]
      setUploading(true)
      setUploadedFile(null)

      const formData = new FormData()
      formData.append('file', {
        uri: file.uri,
        name: file.name,
        type: 'application/pdf',
      } as unknown as Blob)

      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch(`${API_BASE}/api/upload/syllabus`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
        body: formData,
      })

      if (response.ok) {
        setUploadedFile(file.name)
        await loadData()
      }
    } catch {
      // Non-blocking
    } finally {
      setUploading(false)
    }
  }, [loadData])

  /** Persist quiet hours to Supabase */
  const saveQuietHours = useCallback(async (start: string, end: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const { data: user } = await supabase
        .from('users')
        .select('preferences_json')
        .eq('id', session.user.id)
        .single()
      await supabase
        .from('users')
        .update({
          preferences_json: {
            ...(user?.preferences_json ?? {}),
            quiet_hours_start: start,
            quiet_hours_end: end,
          },
        })
        .eq('id', session.user.id)
    } catch {
      // Non-blocking
    }
  }, [])

  /** Cycle through hours for a simple time selector (HH:MM format) */
  const cycleHour = useCallback(
    (current: string, direction: 1 | -1, field: 'start' | 'end') => {
      const [h, m] = current.split(':').map(Number)
      const newHour = ((h + direction + 24) % 24).toString().padStart(2, '0')
      const newTime = `${newHour}:${m.toString().padStart(2, '0')}`
      if (field === 'start') {
        setQuietStart(newTime)
        saveQuietHours(newTime, quietEnd)
      } else {
        setQuietEnd(newTime)
        saveQuietHours(quietStart, newTime)
      }
    },
    [quietEnd, quietStart, saveQuietHours],
  )

  /** Show disconnect confirmation and handle disconnect */
  const handleDisconnect = useCallback((platform: string) => {
    const platformLabel =
      platform === 'google' ? 'Google' : platform === 'todoist' ? 'Todoist' : 'Canvas'
    const detail =
      platform === 'google'
        ? 'This will stop syncing your calendar.'
        : platform === 'todoist'
          ? 'This will stop syncing your Todoist tasks.'
          : 'This will stop syncing your deadlines.'

    const keepLabel = `Keep ${platformLabel}`

    Alert.alert(
      `Disconnect ${platformLabel}?`,
      detail,
      [
        {
          text: keepLabel,
          style: 'cancel',
        },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              const { data: { session } } = await supabase.auth.getSession()
              if (!session) return
              await supabase
                .from('integrations')
                .delete()
                .eq('user_id', session.user.id)
                .eq('platform', platform)
              setIntegrations((prev) => prev.filter((i) => i.platform !== platform))
            } catch {
              // Non-blocking
            }
          },
        },
      ],
    )
  }, [])

  /** Open Todoist OAuth flow via in-app browser and refresh integration status on success */
  const handleConnectTodoist = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const clientId = process.env.EXPO_PUBLIC_TODOIST_CLIENT_ID
      const redirectUri = encodeURIComponent(`${API_BASE}/api/auth/todoist/callback`)
      const authUrl = `https://app.todoist.com/oauth/authorize?client_id=${clientId}&scope=data:read_write&state=${session.user.id}&response_type=code&redirect_uri=${redirectUri}`

      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'aria://todoist-connected')
      if (result.type === 'success') {
        await loadData() // refresh integration status
      }
    } catch {
      // Non-blocking
    }
  }, [loadData])

  /** Restore a hidden card back to the grid */
  const restoreCard = useCallback(async (cardId: string) => {
    const updated = hiddenCards.filter((c) => c.id !== cardId)
    setHiddenCards(updated)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const { data: user } = await supabase
        .from('users')
        .select('preferences_json')
        .eq('id', session.user.id)
        .single()
      await supabase
        .from('users')
        .update({
          preferences_json: {
            ...(user?.preferences_json ?? {}),
            hidden_cards: updated,
          },
        })
        .eq('id', session.user.id)
    } catch {
      // Non-blocking
    }
  }, [hiddenCards])

  const canvasIntegration = integrations.find((i) => i.platform === 'canvas')
  const googleIntegration = integrations.find((i) => i.platform === 'google')
  const todoistIntegration = integrations.find((i) => i.platform === 'todoist')

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Preferences' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.secondary }}
        contentContainerStyle={{ paddingBottom: 48 }}
      >
        {/* Section 1: Accent Color */}
        <View style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.textPrimary }}>
            Accent Color
          </Text>
        </View>
        <View
          style={{
            backgroundColor: colors.dominant,
            marginHorizontal: 16,
            borderRadius: 12,
            padding: 16,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            {(Object.entries(ACCENT_COLORS) as [AccentColorName, string][]).map(
              ([name, hex]) => {
                const isActive = accentName === name
                return (
                  <TouchableOpacity
                    key={name}
                    onPress={() => handleAccentSelect(name)}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: hex,
                      borderWidth: 2,
                      borderColor: isActive ? '#FFFFFF' : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                      shadowColor: isActive ? hex : 'transparent',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: isActive ? 0.6 : 0,
                      shadowRadius: 4,
                    }}
                    accessibilityLabel={`${name} accent color${isActive ? ', selected' : ''}`}
                  >
                    {isActive && (
                      <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                    )}
                  </TouchableOpacity>
                )
              },
            )}
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {(Object.keys(ACCENT_COLORS) as AccentColorName[]).map((name) => (
              <View key={name} style={{ width: 44, alignItems: 'center' }}>
                <Text style={{ fontSize: 10, color: colors.textSecondary }}>{name}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Section 2: Connected Accounts */}
        <View style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.textPrimary }}>
            Connected Accounts
          </Text>
        </View>
        <View
          style={{
            backgroundColor: colors.dominant,
            marginHorizontal: 16,
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {/* Canvas row */}
          {(() => {
            const health = canvasIntegration
              ? getHealthColor(canvasIntegration.synced_at)
              : { dot: '#8E8E93', label: 'Not connected' }
            const isConnected = !!canvasIntegration

            return (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.cardBorder,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: health.dot,
                    marginRight: 12,
                  }}
                />
                <Text style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}>
                  Canvas
                </Text>
                <Text style={{ fontSize: 14, color: colors.textSecondary, marginRight: 12 }}>
                  {health.label}
                </Text>
                {isConnected ? (
                  <TouchableOpacity onPress={() => handleDisconnect('canvas')}>
                    <Text style={{ fontSize: 14, color: colors.destructive }}>Disconnect</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={() => {/* Navigate to Canvas setup */}}>
                    <Text style={{ fontSize: 14, color: accent }}>Connect</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          })()}

          {/* Google row */}
          {(() => {
            const health = googleIntegration
              ? getHealthColor(googleIntegration.synced_at)
              : { dot: '#8E8E93', label: 'Not connected' }
            const isConnected = !!googleIntegration

            return (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.cardBorder,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: health.dot,
                    marginRight: 12,
                  }}
                />
                <Text style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}>
                  Google
                </Text>
                <Text style={{ fontSize: 14, color: colors.textSecondary, marginRight: 12 }}>
                  {health.label}
                </Text>
                {isConnected ? (
                  <TouchableOpacity onPress={() => handleDisconnect('google')}>
                    <Text style={{ fontSize: 14, color: colors.destructive }}>Disconnect</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={() => {/* Navigate to Google OAuth */}}>
                    <Text style={{ fontSize: 14, color: accent }}>Connect</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          })()}

          {/* Todoist row */}
          {(() => {
            const health = todoistIntegration
              ? getHealthColor(todoistIntegration.synced_at)
              : { dot: '#8E8E93', label: 'Not connected' }
            const isConnected = !!todoistIntegration

            return (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: health.dot,
                    marginRight: 12,
                  }}
                />
                <Text style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}>
                  Todoist
                </Text>
                <Text style={{ fontSize: 14, color: colors.textSecondary, marginRight: 12 }}>
                  {health.label}
                </Text>
                {isConnected ? (
                  <TouchableOpacity onPress={() => handleDisconnect('todoist')}>
                    <Text style={{ fontSize: 14, color: colors.destructive }}>Disconnect</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={handleConnectTodoist}>
                    <Text style={{ fontSize: 14, color: accent }}>Connect</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          })()}
        </View>

        {/* Section 3: Syllabi */}
        <View style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.textPrimary }}>
            Syllabi
          </Text>
        </View>
        <View
          style={{
            backgroundColor: colors.dominant,
            marginHorizontal: 16,
            borderRadius: 12,
            padding: 16,
            gap: 12,
          }}
        >
          <TouchableOpacity
            onPress={pickSyllabus}
            disabled={uploading}
            style={{
              height: 44,
              borderRadius: 12,
              backgroundColor: accent,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: 8,
              opacity: uploading ? 0.7 : 1,
            }}
            accessibilityLabel="Upload Syllabus PDF"
          >
            {uploading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="document-attach-outline" size={18} color="#FFFFFF" />
                <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                  Upload Syllabus
                </Text>
              </>
            )}
          </TouchableOpacity>

          {uploadedFile && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="checkmark-circle" size={18} color="#34C759" />
              <Text style={{ fontSize: 14, color: colors.textSecondary }} numberOfLines={1}>
                {uploadedFile}
              </Text>
            </View>
          )}

          {syllabi.length > 0 && (
            <View style={{ gap: 8, marginTop: 4 }}>
              {syllabi.map((s) => (
                <View
                  key={s.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 4,
                    gap: 8,
                  }}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={16}
                    color={colors.textSecondary}
                  />
                  <Text
                    style={{ flex: 1, fontSize: 14, color: colors.textPrimary }}
                    numberOfLines={1}
                  >
                    {s.course_name}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Section 4: Quiet Hours */}
        <View style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.textPrimary }}>
            Quiet Hours
          </Text>
        </View>
        <View
          style={{
            backgroundColor: colors.dominant,
            marginHorizontal: 16,
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {/* Quiet start row */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: colors.cardBorder,
            }}
          >
            <Text style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}>
              No SMS after
            </Text>
            <TouchableOpacity onPress={() => cycleHour(quietStart, -1, 'start')}>
              <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text
              style={{
                fontSize: 16,
                fontWeight: '600',
                color: colors.textPrimary,
                marginHorizontal: 12,
                minWidth: 56,
                textAlign: 'center',
              }}
            >
              {quietStart}
            </Text>
            <TouchableOpacity onPress={() => cycleHour(quietStart, 1, 'start')}>
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Quiet end row */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <Text style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}>
              Resume SMS at
            </Text>
            <TouchableOpacity onPress={() => cycleHour(quietEnd, -1, 'end')}>
              <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text
              style={{
                fontSize: 16,
                fontWeight: '600',
                color: colors.textPrimary,
                marginHorizontal: 12,
                minWidth: 56,
                textAlign: 'center',
              }}
            >
              {quietEnd}
            </Text>
            <TouchableOpacity onPress={() => cycleHour(quietEnd, 1, 'end')}>
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Section 5: Hidden Cards */}
        <View style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.textPrimary }}>
            Hidden Cards
          </Text>
        </View>
        <View
          style={{
            backgroundColor: colors.dominant,
            marginHorizontal: 16,
            borderRadius: 12,
            padding: 16,
          }}
        >
          {hiddenCards.length === 0 ? (
            <Text style={{ fontSize: 16, color: colors.textSecondary }}>No hidden cards</Text>
          ) : (
            <View style={{ gap: 12 }}>
              {hiddenCards.map((card) => (
                <View
                  key={card.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}
                    numberOfLines={1}
                  >
                    {card.title}
                  </Text>
                  <TouchableOpacity onPress={() => restoreCard(card.id)}>
                    <Text style={{ fontSize: 14, color: accent }}>Show</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </>
  )
}
