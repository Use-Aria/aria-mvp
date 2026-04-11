import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import ProgressBar from '@/components/onboarding/ProgressBar'
import PinInput from '@/components/onboarding/PinInput'

const RESEND_COOLDOWN_SECONDS = 30

/**
 * Onboarding Step 4 — Phone OTP verification.
 *
 * On mount: calls POST /api/auth/phone/send with the phone param from profile screen.
 * Auto-submits on 6th digit via PinInput.onComplete.
 * Navigates to tcpa on success.
 *
 * Error handling:
 *   API 410 → code expired — prompt resend
 *   API 422 → wrong code — try again
 *
 * Resend button appears after 30s cooldown (same timer starts on mount since
 * send is called immediately).
 */
export default function VerifyPhone() {
  const router = useRouter()
  const { phone } = useLocalSearchParams<{ phone: string }>()
  const { accent, colors } = useTheme()

  const [pinError, setPinError] = useState<string | undefined>(undefined)
  const [isVerifying, setIsVerifying] = useState(false)
  const [isSending, setIsSending] = useState(true) // true while initial send is in flight
  const [sendError, setSendError] = useState<string | null>(null)
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

  // Send OTP on mount
  useEffect(() => {
    const sendOtp = async () => {
      try {
        await api.sendPhoneOtp(phone ?? '')
        startCooldown()
      } catch {
        setSendError("Couldn't send the code. Check your number and go back to try again.")
      } finally {
        setIsSending(false)
      }
    }
    sendOtp()
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleComplete = async (code: string) => {
    if (isVerifying) return
    setPinError(undefined)
    setIsVerifying(true)
    try {
      await api.verifyPhoneOtp(phone ?? '', code)
      router.push('/(onboarding)/tcpa')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('410')) {
        setPinError("Code expired. Tap 'Resend' to get a new one.")
      } else if (message.includes('422')) {
        setPinError("That code didn't match. Try again.")
      } else {
        setPinError("Something went wrong. Please try again.")
      }
    } finally {
      setIsVerifying(false)
    }
  }

  const handleResend = async () => {
    if (!canResend || isVerifying) return
    setPinError(undefined)
    setSendError(null)
    try {
      await api.sendPhoneOtp(phone ?? '')
      startCooldown()
    } catch {
      setPinError("Couldn't send the code. Please try again.")
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={4} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
          Enter the code
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, marginBottom: 32 }}>
          Sent to {phone}
        </Text>

        {isSending ? (
          <ActivityIndicator color={accent} style={{ marginTop: 16 }} />
        ) : sendError ? (
          <Text style={{ color: '#FF3B30', fontSize: 15, lineHeight: 22 }}>{sendError}</Text>
        ) : (
          <>
            <PinInput onComplete={handleComplete} error={pinError} />

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
          </>
        )}
      </View>
    </SafeAreaView>
  )
}
