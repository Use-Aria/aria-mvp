import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { api } from '@/lib/api'
import { useTheme } from '@/lib/theme'

/**
 * Onboarding Step 7 — Completion screen.
 *
 * On mount: calls POST /api/onboarding/complete which:
 *   1. Sets onboarding_completed_at in the users table
 *   2. Enqueues the tasks.welcome_briefing Celery task (triggers welcome SMS)
 *
 * Shows a loading state while the request is in flight.
 * "Enter Aria" navigates with router.replace (not push) so the user cannot
 * swipe back into the onboarding stack.
 *
 * Handles API failure gracefully — user can still enter the app even if the
 * completion call fails (welcome SMS will be delayed but not blocking).
 */
export default function Success() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    api
      .completeOnboarding()
      .then(() => {
        setReady(true)
      })
      .catch(() => {
        // Completion call failed — still let the user in, welcome SMS may be delayed
        setReady(true)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <View style={{ flex: 1, paddingHorizontal: 28, justifyContent: 'center', alignItems: 'center' }}>
        {loading ? (
          <>
            <ActivityIndicator size="large" color={accent} style={{ marginBottom: 20 }} />
            <Text style={{ fontSize: 18, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' }}>
              Aria is setting up your account
            </Text>
            <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginTop: 8 }}>
              Hang on a second…
            </Text>
          </>
        ) : (
          <>
            <View style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: `${accent}15`,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 24,
            }}>
              <Ionicons name="checkmark" size={40} color={accent} />
            </View>

            <Text style={{ fontSize: 34, fontWeight: '800', color: colors.textPrimary, textAlign: 'center', marginBottom: 12 }}>
              You&apos;re all set.
            </Text>
            <Text style={{ fontSize: 16, color: colors.textSecondary, textAlign: 'center', lineHeight: 24 }}>
              Aria will text you your first briefing tomorrow morning. Welcome.
            </Text>
          </>
        )}
      </View>

      {ready ? (
        <View style={{ paddingHorizontal: 28, paddingBottom: 48 }}>
          <TouchableOpacity
            onPress={() => router.replace('/(home)')}
            style={{
              backgroundColor: accent,
              borderRadius: 14,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#FFFFFF' }}>
              Enter Aria
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  )
}
