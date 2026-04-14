import React, { useState } from 'react'
import {
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import PhoneInput from '@/components/onboarding/PhoneInput'

/**
 * Onboarding Step 2 — Phone number entry.
 *
 * Collects the user's phone number and sends a 6-digit OTP via Supabase
 * phone auth (backed by Twilio). The phone number is the primary auth
 * identity — no Apple or Google sign-in at this step.
 *
 * On success: navigate to verify-phone with the E.164 phone as a route param.
 *
 * E.164 conversion: PhoneInput formats as "+1 (555) 123-4567". We strip
 * non-digits and prepend "+1" for US numbers (MVP = Yale students).
 */
export default function Auth() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const phoneDigits = phone.replace(/\D/g, '').length
  const isPhoneValid = phoneDigits >= 11 // formatted value includes '1' from '+1' country code

  /** Convert PhoneInput display value to E.164 (e.g. "+1 (555) 123-4567" → "+15551234567") */
  const toE164 = (display: string): string => {
    const digits = display.replace(/\D/g, '')
    return `+1${digits.slice(-10)}`
  }

  const handleSendCode = async () => {
    if (!isPhoneValid || loading) return
    setError(null)
    setLoading(true)

    const e164 = toE164(phone)
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: e164 })
    setLoading(false)

    if (otpError) {
      console.error('[auth] signInWithOtp error:', JSON.stringify(otpError))
      setError(otpError.message ?? "Couldn't send the code. Check your number and try again.")
      return
    }

    router.push({ pathname: '/(onboarding)/verify-phone', params: { phone: e164 } })
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={{ flex: 1, paddingHorizontal: 28, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ fontSize: 13, fontWeight: '700', color: accent, letterSpacing: 1.2, marginBottom: 10 }}>
            ARIA · AI PERSONAL ASSISTANT
          </Text>
          <Text style={{ fontSize: 34, fontWeight: '800', color: colors.textPrimary, lineHeight: 40, marginBottom: 12 }}>
            {"What's your number?"}
          </Text>
          <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 40 }}>
            {"We'll text you a code to verify your number. No app download required."}
          </Text>

          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>
            Phone number
          </Text>
          <PhoneInput
            value={phone}
            onChangeText={setPhone}
            isValid={isPhoneValid}
            error={error ?? undefined}
          />

          <TouchableOpacity
            testID="send-code-btn"
            onPress={handleSendCode}
            disabled={!isPhoneValid || loading}
            style={{
              backgroundColor: accent,
              borderRadius: 14,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 32,
              opacity: !isPhoneValid || loading ? 0.4 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#FFFFFF' }}>
                Send code
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
