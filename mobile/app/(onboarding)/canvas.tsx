import React, { useState } from 'react'
import { View, Text, TouchableOpacity, SafeAreaView } from 'react-native'
import { useRouter } from 'expo-router'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import ProgressBar from '@/components/onboarding/ProgressBar'
import CanvasUrlInput from '@/components/onboarding/CanvasUrlInput'

type ValidationStatus = 'idle' | 'validating' | 'valid' | 'error'

const CANVAS_URL_REGEX = /^(webcal|https?):\/\/.*/
const VALIDATION_TIMEOUT_MS = 10_000

/**
 * Onboarding Step 4 — Canvas iCal URL entry.
 * User pastes their Canvas calendar feed URL. Aria validates it against the backend.
 * Shows specific error messages for format errors, unreachable URLs, and empty feeds.
 * "Continue" CTA is shown only after successful validation.
 */
export default function Canvas() {
  const router = useRouter()
  const { accent } = useTheme()

  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<ValidationStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const handleValidate = async () => {
    setErrorMessage(undefined)

    // Client-side format check before hitting the backend
    if (!CANVAS_URL_REGEX.test(url.trim())) {
      setStatus('error')
      setErrorMessage(
        "That doesn't look like a Canvas iCal URL. It should start with webcal:// or https://"
      )
      return
    }

    setStatus('validating')

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), VALIDATION_TIMEOUT_MS)
    )

    try {
      const result = await Promise.race([
        api.validateCanvasUrl(url.trim()),
        timeoutPromise,
      ])

      // Check for 200 but empty feed — backend returns a specific indicator
      if (result && result.deadline_count === 0) {
        setStatus('error')
        setErrorMessage(
          'URL connected but no deadlines found. Make sure your Canvas calendar has events.'
        )
        return
      }

      setStatus('valid')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      setStatus('error')

      if (message === 'timeout' || message.includes('404')) {
        setErrorMessage(
          "Couldn't reach that Canvas feed. Double-check the URL in Canvas \u2192 Calendar \u2192 Feed."
        )
      } else if (message.includes('400')) {
        setErrorMessage(
          "That doesn't look like a Canvas iCal URL. It should start with webcal:// or https://"
        )
      } else {
        setErrorMessage(
          "Couldn't reach that Canvas feed. Double-check the URL in Canvas \u2192 Calendar \u2192 Feed."
        )
      }
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
      <View style={{ flex: 1, paddingTop: 48 }}>
        <ProgressBar currentStep={4} />

        <View style={{ flex: 1, paddingHorizontal: 24 }}>
          <View style={{ marginTop: 32 }}>
            <Text style={{ fontSize: 28, fontWeight: '600', color: '#000000', marginBottom: 8 }}>
              Connect Canvas
            </Text>
            <Text style={{ fontSize: 16, color: '#6E6E73', marginBottom: 32 }}>
              Paste your Canvas iCal URL so Aria can track your deadlines.
            </Text>

            <CanvasUrlInput
              value={url}
              onChangeText={(text) => {
                setUrl(text)
                if (status !== 'idle') setStatus('idle')
              }}
              onValidate={handleValidate}
              status={status}
              errorMessage={errorMessage}
            />
          </View>

          <View style={{ flex: 1 }} />

          {status === 'valid' ? (
            <TouchableOpacity
              onPress={() => router.push('/(onboarding)/google')}
              style={{
                backgroundColor: accent,
                borderRadius: 12,
                paddingVertical: 16,
                alignItems: 'center',
                marginBottom: 32,
              }}
            >
              <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                Continue
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={{ marginBottom: 32, height: 56 }} />
          )}
        </View>
      </View>
    </SafeAreaView>
  )
}
