import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { api } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'

/**
 * Onboarding Step 7 — First briefing preview screen.
 *
 * Fetches /api/briefing/preview (BriefingPreviewResponse) on mount.
 * This route does NOT exist yet — the screen handles 404/500 gracefully
 * by showing a fallback message with a "Continue anyway" button.
 *
 * "Enter Aria" uses router.replace (not push) to remove the onboarding stack
 * so the user cannot swipe back into onboarding from the home screen.
 */
export default function BriefingPreview() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [briefing, setBriefing] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(true)

  useEffect(() => {
    api
      .getBriefingPreview()
      .then((data) => {
        setBriefing(data.briefing_text ?? JSON.stringify(data))
        setLoadingPreview(false)
      })
      .catch(() => {
        setLoadingPreview(false)
        // briefing stays null — error state rendered below
      })
  }, [])

  const navigateHome = () => {
    router.replace('/(home)')
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={7} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        {/* Heading */}
        <Text
          style={{
            fontSize: 28,
            fontWeight: '600',
            color: colors.textPrimary,
            marginBottom: 8,
          }}
        >
          Your first briefing
        </Text>

        {/* Subheading */}
        <Text
          style={{
            fontSize: 16,
            color: colors.textSecondary,
            lineHeight: 24,
            marginBottom: 24,
          }}
        >
          Here&apos;s a preview of what Aria will send you each morning.
        </Text>

        {/* Briefing content area */}
        {loadingPreview ? (
          // Loading skeleton — 3 shimmer lines
          <View
            style={{
              backgroundColor: colors.secondary,
              borderRadius: 16,
              padding: 16,
            }}
          >
            {[1, 2, 3].map((i) => (
              <View
                key={i}
                style={{
                  height: 16,
                  borderRadius: 4,
                  backgroundColor: colors.cardBorder,
                  marginBottom: i < 3 ? 12 : 0,
                  width: i === 3 ? '60%' : '100%',
                }}
              />
            ))}
          </View>
        ) : briefing !== null ? (
          // Success state — briefing card
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 16 }}
            showsVerticalScrollIndicator={false}
          >
            <View
              style={{
                backgroundColor: colors.secondary,
                borderRadius: 16,
                padding: 16,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.08,
                shadowRadius: 8,
                elevation: 2,
              }}
            >
              <Text
                style={{
                  fontSize: 16,
                  color: colors.textPrimary,
                  lineHeight: 24,
                }}
              >
                {briefing}
              </Text>
            </View>
          </ScrollView>
        ) : (
          // Error state — graceful degradation for 404/500 from /api/briefing/preview
          <View
            style={{
              backgroundColor: colors.secondary,
              borderRadius: 16,
              padding: 16,
            }}
          >
            <Text
              style={{
                fontSize: 16,
                color: colors.textSecondary,
                lineHeight: 24,
                marginBottom: 16,
              }}
            >
              Couldn&apos;t load preview. Your first briefing will arrive tomorrow morning.
            </Text>
            <TouchableOpacity
              onPress={navigateHome}
              style={{
                backgroundColor: accent,
                borderRadius: 12,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                Continue anyway
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Enter Aria CTA — shown when not in error state */}
      {briefing !== null && !loadingPreview ? (
        <View style={{ paddingHorizontal: 24, paddingBottom: 32 }}>
          <TouchableOpacity
            onPress={navigateHome}
            style={{
              backgroundColor: accent,
              borderRadius: 12,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
              Enter Aria
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  )
}
