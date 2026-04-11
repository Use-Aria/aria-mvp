import React, { useState, useEffect } from 'react'
import {
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { api } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'

/**
 * Onboarding Step 4 — Profile collection.
 *
 * Collects name (pre-filled from Supabase session metadata), university,
 * and graduation year. Phone is already captured and verified via OTP.
 * Submits to POST /api/onboarding/profile, then navigates to tcpa.
 *
 * Graduation year is a numeric text input (keyboard: number-pad). Valid range: 2024–2035.
 */
export default function Profile() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [name, setName] = useState('')
  const [university, setUniversity] = useState('')
  const [gradYear, setGradYear] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill name from session metadata
  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const fullName = session?.user?.user_metadata?.full_name as string | undefined
      if (fullName) setName(fullName)
    })()
  }, [])

  const gradYearNum = parseInt(gradYear, 10)
  const isGradYearValid = !isNaN(gradYearNum) && gradYearNum >= 2024 && gradYearNum <= 2035

  const isFormValid =
    name.trim().length > 0 &&
    university.trim().length > 0 &&
    isGradYearValid

  const handleContinue = async () => {
    if (!isFormValid || isLoading) return
    setError(null)
    setIsLoading(true)

    try {
      await api.saveProfile({
        name: name.trim(),
        university: university.trim(),
        graduation_year: gradYearNum,
      })
      router.push('/(onboarding)/tcpa')
    } catch {
      setError("Couldn't save your profile. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  const inputStyle = {
    height: 56,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    borderColor: colors.cardBorder,
    color: colors.textPrimary,
    backgroundColor: colors.dominant,
  }

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: colors.textSecondary,
    marginBottom: 6,
    marginTop: 16,
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={4} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
            Tell us about you
          </Text>
          <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 8 }}>
            This helps Aria personalise your briefings.
          </Text>

          {error ? (
            <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 8 }}>{error}</Text>
          ) : null}

          {/* Name */}
          <Text style={labelStyle}>Full name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={colors.textSecondary}
            autoComplete="name"
            returnKeyType="next"
            style={inputStyle}
          />

          {/* University */}
          <Text style={labelStyle}>University</Text>
          <TextInput
            value={university}
            onChangeText={setUniversity}
            placeholder="e.g. Yale University"
            placeholderTextColor={colors.textSecondary}
            returnKeyType="next"
            style={inputStyle}
          />

          {/* Graduation year */}
          <Text style={labelStyle}>Graduation year</Text>
          <TextInput
            value={gradYear}
            onChangeText={(t) => setGradYear(t.replace(/\D/g, '').slice(0, 4))}
            placeholder="e.g. 2027"
            placeholderTextColor={colors.textSecondary}
            keyboardType="number-pad"
            maxLength={4}
            returnKeyType="done"
            onSubmitEditing={handleContinue}
            style={[
              inputStyle,
              gradYear.length === 4 && !isGradYearValid ? { borderColor: '#FF3B30' } : {},
            ]}
          />
          {gradYear.length === 4 && !isGradYearValid ? (
            <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 6 }}>
              Enter a year between 2024 and 2035
            </Text>
          ) : null}

          <Pressable
            onPress={handleContinue}
            disabled={!isFormValid || isLoading}
            style={{
              backgroundColor: accent,
              borderRadius: 12,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 32,
              opacity: !isFormValid || isLoading ? 0.4 : 1,
            }}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text
                disabled={!isFormValid || isLoading}
                style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}
              >
                Continue
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
