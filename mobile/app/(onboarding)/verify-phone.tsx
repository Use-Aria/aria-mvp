import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'
import PinInput from '@/components/onboarding/PinInput'

const RESEND_COOLDOWN_SECONDS = 30

/**
 * Onboarding Step 3 — Phone OTP verification.
 *
 * OTP was already sent by auth.tsx via supabase.auth.signInWithOtp.
 * This screen calls supabase.auth.verifyOtp to verify the code and
 * create the Supabase session.
 *
 * On success: navigate to profile (step 4).
 *
 * Error handling:
 *   Supabase "Token has expired" → prompt resend
 *   Supabase "invalid" → wrong code, try again
 *
 * Resend: calls supabase.auth.signInWithOtp again (same phone).
 * Cooldown starts on mount since OTP was already sent by auth screen.
 */
export default function VerifyPhone() {
  const router = useRouter()
  const { phone } = useLocalSearchParams<{ phone: string }>()
  const { accent, colors } = useTheme()

  const [pinError, setPinError] = useState<string | undefined>(undefined)
  const [isVerifying, setIsVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS)
  const [canResend, setCanResend] = useState(false)
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = () => {
    setCanResend(false)
    setResendCooldown(RESEND_COOLDOWN_SECONDS)
    if (cooldownRef.current) clearInterval(cooldownRef.current)
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current)
          setCanResend(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  // OTP was already sent by auth.tsx — just start the cooldown timer on mount
  useEffect(() => {
    startCooldown()
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current)
    }
  }, [])

  const handleComplete = async (code: string) => {
    if (isVerifying) return
    setPinError(undefined)
    setIsVerifying(true)

    const { error } = await supabase.auth.verifyOtp({
      phone: phone ?? '',
      token: code,
      type: 'sms',
    })

    setIsVerifying(false)

    if (error) {
      const msg = error.message.toLowerCase()
      if (msg.includes('expired')) {
        setPinError("Code expired. Tap 'Resend' to get a new one.")
      } else {
        setPinError("That code didn't match. Try again.")
      }
      return
    }

    router.push('/(onboarding)/profile')
  }

  const handleResend = async () => {
    if (!canResend || isVerifying) return
    setPinError(undefined)
    const { error } = await supabase.auth.signInWithOtp({ phone: phone ?? '' })
    if (error) {
      setPinError("Couldn't resend the code. Please try again.")
      return
    }
    startCooldown()
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={3} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        <TouchableOpacity onPress={() => router.replace('/(onboarding)/auth')} style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 16, color: accent }}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
          Enter the code
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, marginBottom: 32 }}>
          Sent to {phone}
        </Text>

        <PinInput testID="pin-input" onComplete={handleComplete} error={pinError} />

        {isVerifying ? (
          <ActivityIndicator color={accent} style={{ marginTop: 24 }} />
        ) : (
          <TouchableOpacity
            onPress={handleResend}
            disabled={!canResend || isVerifying}
            style={{ marginTop: 24, alignItems: 'center' }}
          >
            <Text
              style={{
                fontSize: 16,
                color: canResend && !isVerifying ? accent : colors.textSecondary,
                fontWeight: canResend && !isVerifying ? '600' : '400',
              }}
            >
              {canResend ? 'Resend code' : `Resend in ${resendCooldown}s`}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  )
}
