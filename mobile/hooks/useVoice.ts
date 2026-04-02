import { useState } from 'react'

// expo-speech-recognition requires a native module that is not available in Expo Go
// or in the simulator without a dev client build. We guard the import so the app
// doesn't crash in demo mode or when the module hasn't been compiled in.
let ExpoSpeechRecognitionModule: {
  stop: () => void
  requestPermissionsAsync: () => Promise<{ granted: boolean }>
  start: (opts: { lang: string; continuous: boolean }) => void
} | null = null

let useSpeechRecognitionEvent: (
  event: string,
  handler: (e: any) => void
) => void = () => {}

try {
  const mod = require('expo-speech-recognition')
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent
} catch {
  // Native module not available — voice input will be disabled (no-op)
}

/**
 * useVoice — two-tap voice input state machine.
 *
 * Tap once to start recording. Tap again to stop immediately.
 *
 * Two mechanisms work together:
 * - `continuous: false` ensures recognition auto-stops after one utterance (silence detection)
 * - The manual toggle calls `stop()` to stop mid-utterance without waiting for silence
 *
 * @param onResult - callback invoked with the final transcript text
 * @returns toggle function, isListening state, permissionDenied state
 */
export function useVoice(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)

  /**
   * Toggle voice recognition on/off.
   * - If currently listening: immediately stop recognition (does not wait for silence detection)
   * - If not listening: request permission, then start recognition
   */
  const toggle = async () => {
    if (!ExpoSpeechRecognitionModule) {
      // Native module unavailable — silently no-op
      return
    }
    if (isListening) {
      // Immediately stop recognition — does not wait for silence detection
      ExpoSpeechRecognitionModule.stop()
      setIsListening(false)
    } else {
      const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!granted) {
        setPermissionDenied(true)
        return
      }
      setPermissionDenied(false)
      // continuous: false — auto-stops after one utterance via silence detection
      ExpoSpeechRecognitionModule.start({ lang: 'en-US', continuous: false })
      setIsListening(true)
    }
  }

  useSpeechRecognitionEvent('result', (event: any) => {
    if (event.isFinal) {
      setIsListening(false)
      const transcript = event.results[0]?.transcript ?? ''
      if (transcript) onResult(transcript)
    }
  })

  useSpeechRecognitionEvent('end', () => setIsListening(false))
  useSpeechRecognitionEvent('error', () => setIsListening(false))

  return { toggle, isListening, permissionDenied }
}
