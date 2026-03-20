import React, { useState } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native'
import { useRouter } from 'expo-router'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import ProgressBar from '@/components/onboarding/ProgressBar'
import PhoneInput from '@/components/onboarding/PhoneInput'

/**
 * Onboarding Step 2 — Phone number entry.
 * User enters their US phone number and taps "Send verification code".
 * On success, navigates to the verify screen with the phone number as a param.
 */
export default function Phone() {
  const router = useRouter()
  const { accent } = useTheme()

  const [phone, setPhone] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // Strip non-digits to count actual digits for validation
  const digitCount = phone.replace(/\D/g, '').length
  const isValid = digitCount >= 10

  const handleSend = async () => {
    if (!isValid || isLoading) return
    setError(undefined)
    setIsLoading(true)
    try {
      await api.sendPhoneOtp(phone)
      router.push({ pathname: '/(onboarding)/verify', params: { phone } })
    } catch {
      setError("Couldn't send the code. Check your number and try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
      <View style={{ flex: 1, paddingTop: 48 }}>
        <ProgressBar currentStep={2} />

        <View style={{ flex: 1, paddingHorizontal: 24 }}>
          <View style={{ marginTop: 32 }}>
            <Text style={{ fontSize: 28, fontWeight: '600', color: '#000000', marginBottom: 8 }}>
              What&apos;s your number?
            </Text>
            <Text style={{ fontSize: 16, color: '#6E6E73', marginBottom: 32 }}>
              We&apos;ll send you a verification code.
            </Text>
            <PhoneInput
              value={phone}
              onChangeText={setPhone}
              isValid={isValid}
              error={error}
            />
          </View>

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            onPress={handleSend}
            disabled={!isValid || isLoading}
            style={{
              backgroundColor: accent,
              borderRadius: 12,
              paddingVertical: 16,
              alignItems: 'center',
              marginBottom: 32,
              opacity: !isValid || isLoading ? 0.4 : 1,
            }}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                Send verification code
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  )
}
