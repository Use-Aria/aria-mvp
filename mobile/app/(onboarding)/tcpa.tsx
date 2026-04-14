import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'

/**
 * Onboarding Step 6 — TCPA consent screen.
 *
 * Allows users to opt in to time-sensitive deadline alerts that bypass quiet hours.
 * TCPA compliance requirement: toggle MUST default to OFF. User must explicitly enable.
 * Writes has_alert_consent (true or false) to users.preferences_json on confirm.
 * This flag is read by Phase 5's send_sms_alert() to determine alert bypass eligibility.
 */
export default function TcpaConsent() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [hasConsent, setHasConsent] = useState(false) // MUST default OFF per TCPA requirement
  const [saving, setSaving] = useState(false)

  // Restore previously saved consent value on mount
  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user?.id) return
      const { data: user } = await supabase
        .from('users')
        .select('preferences_json')
        .eq('id', session.user.id)
        .single()
      const prefs = user?.preferences_json as Record<string, unknown> | null
      if (prefs && typeof prefs.has_alert_consent === 'boolean') {
        setHasConsent(prefs.has_alert_consent)
      }
    })()
  }, [])

  /**
   * Reads current preferences_json to preserve existing fields, then merges
   * has_alert_consent. Writes explicit false if toggle is OFF (not omitted) —
   * required so Phase 5 alert logic can distinguish "declined" from "never set".
   */
  const handleConfirm = async () => {
    setSaving(true)
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      setSaving(false)
      return
    }

    // Read current preferences first to avoid clobbering other keys
    const { data: user } = await supabase
      .from('users')
      .select('preferences_json')
      .eq('id', session.user.id)
      .single()

    const currentPrefs = (user?.preferences_json as Record<string, unknown>) ?? {}

    const { error } = await supabase
      .from('users')
      .update({
        preferences_json: { ...currentPrefs, has_alert_consent: hasConsent },
      })
      .eq('id', session.user.id)

    setSaving(false)
    if (!error) {
      router.push('/(onboarding)/tools')
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={6} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        {/* Heading */}
        <TouchableOpacity onPress={() => router.replace('/(onboarding)/profile')} style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 16, color: accent }}>← Back</Text>
        </TouchableOpacity>
        <Text
          style={{
            fontSize: 28,
            fontWeight: '600',
            color: colors.textPrimary,
            marginBottom: 8,
          }}
        >
          SMS briefings & alerts
        </Text>

        {/* Subheading */}
        <Text
          style={{
            fontSize: 16,
            color: colors.textSecondary,
            lineHeight: 24,
            marginBottom: 32,
          }}
        >
          Aria sends you a daily morning briefing and notifies you when deadlines change.
        </Text>

        {/* Toggle row */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          {/* Legal copy */}
          <Text
            style={{
              flex: 1,
              fontSize: 16,
              color: colors.textPrimary,
              lineHeight: 24,
              paddingRight: 12,
            }}
          >
            I agree to receive SMS briefings and deadline alerts from Aria.
          </Text>

          {/* Switch — defaults OFF per TCPA requirement */}
          <Switch
            value={hasConsent}
            onValueChange={setHasConsent}
            trackColor={{ false: '#E5E5EA', true: accent }}
            thumbColor="#FFFFFF"
          />
        </View>

        {/* TCPA legal subtext */}
        <Text
          style={{
            fontSize: 14,
            color: colors.textSecondary,
            lineHeight: 20,
            marginTop: 8,
          }}
        >
          Standard SMS rates apply. You can change this at any time in settings.
        </Text>

        {/* Warning — shown when user has not given consent */}
        {!hasConsent && (
          <View
            style={{
              marginTop: 20,
              backgroundColor: colors.secondary,
              borderRadius: 10,
              padding: 14,
              borderLeftWidth: 3,
              borderLeftColor: '#FF9500',
            }}
          >
            <Text
              style={{
                fontSize: 14,
                color: colors.textSecondary,
                lineHeight: 20,
              }}
            >
              Without this, Aria won't send morning briefings or deadline alerts. You'll need to text Aria to get updates.
            </Text>
          </View>
        )}
      </View>

      {/* Continue CTA — always enabled (user can continue with toggle OFF) */}
      <View style={{ paddingHorizontal: 24, paddingBottom: 32 }}>
        <TouchableOpacity
          onPress={handleConfirm}
          disabled={saving}
          style={{
            backgroundColor: accent,
            borderRadius: 12,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
              Continue
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}
