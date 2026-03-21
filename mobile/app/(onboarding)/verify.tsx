import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, SafeAreaView } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import ProgressBar from '@/components/onboarding/ProgressBar'
import PinInput from '@/components/onboarding/PinInput'

const RESEND_COOLDOWN_SECONDS = 30

/**
 * Onboarding Step 3 — SMS PIN verification.
 * User enters the 6-digit code sent to their phone.
 * Auto-advances to canvas screen on 6th digit; no submit button required.
 * Includes a resend link with 30-second cooldown.
 */
export default function Verify() {
  const router = useRouter()
  const { phone } = useLocalSearchParams<{ phone: string }>()
  const { accent } = useTheme()

  const [pinError, setPinError] = useState<string | undefined>(undefined)
  const [isVerifying, setIsVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS)
  const [canResend, setCanResend] = useState(false)
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start initial cooldown on mount (code was just sent from phone screen)
  useEffect(() => {
    startCooldown()
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current)
    }
  }, [])

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

  const handleComplete = async (code: string) => {
    if (isVerifying) return
    setPinError(undefined)
    setIsVerifying(true)
    try {
      await api.verifyPhoneOtp(phone ?? '', code)
      router.push('/(onboarding)/canvas')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('410')) {
        setPinError("Code expired. Tap 'Resend' to get a new one.")
      } else {
        setPinError("That code didn't match. Try again.")
      }
    } finally {
      setIsVerifying(false)
    }
  }

  const handleResend = async () => {
    if (!canResend) return
    setPinError(undefined)
    try {
      await api.sendPhoneOtp(phone ?? '')
      startCooldown()
    } catch {
      setPinError("Couldn't send the code. Check your number and try again.")
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
      <View style={{ flex: 1, paddingTop: 48 }}>
        <ProgressBar currentStep={3} />

        <View style={{ flex: 1, paddingHorizontal: 24 }}>
          <View style={{ marginTop: 32 }}>
            <Text style={{ fontSize: 28, fontWeight: '600', color: '#000000', marginBottom: 8 }}>
              Enter the code
            </Text>
            <Text style={{ fontSize: 16, color: '#6E6E73', marginBottom: 32 }}>
              Sent to {phone}
            </Text>

            <PinInput
              onComplete={handleComplete}
              error={pinError}
            />

            <TouchableOpacity
              onPress={handleResend}
              disabled={!canResend}
              style={{ marginTop: 24, alignItems: 'center' }}
            >
              <Text
                style={{
                  fontSize: 16,
                  color: canResend ? accent : '#6E6E73',
                  fontWeight: canResend ? '600' : '400',
                }}
              >
                {canResend ? 'Resend code' : `Resend in ${resendCooldown}s`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </SafeAreaView>
  )
}
