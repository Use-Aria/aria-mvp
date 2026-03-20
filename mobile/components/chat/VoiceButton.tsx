import React, { useEffect, useRef } from 'react'
import {
  Animated,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'
import { useVoice } from '@/hooks/useVoice'

type VoiceButtonProps = {
  /** Called with the final transcribed text when recognition completes */
  onResult: (text: string) => void
}

/**
 * VoiceButton — tap-to-start / tap-to-stop mic button.
 *
 * States:
 * - Idle: mic-outline icon in textSecondary
 * - Listening: mic icon in accent color with animated pulsing outer ring
 * - Permission denied: mic-off-outline icon with inline error message
 *
 * Uses the useVoice hook for the two-tap model:
 * - First tap starts recognition
 * - Second tap stops immediately (does not wait for silence detection)
 */
export function VoiceButton({ onResult }: VoiceButtonProps) {
  const { accent, colors } = useTheme()
  const { toggle, isListening, permissionDenied } = useVoice(onResult)

  const pulseAnim = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (isListening) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ]),
      )
      loop.start()
      return () => loop.stop()
    } else {
      pulseAnim.setValue(1)
    }
  }, [isListening, pulseAnim])

  return (
    <View style={{ alignItems: 'center' }}>
      <TouchableOpacity
        onPress={toggle}
        style={{
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        accessibilityLabel={isListening ? 'Stop recording' : 'Start voice input'}
        accessibilityRole="button"
      >
        {isListening ? (
          <Animated.View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              borderWidth: 2,
              borderColor: accent,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: pulseAnim }],
            }}
          >
            <Ionicons name="mic" size={24} color={accent} />
          </Animated.View>
        ) : (
          <Ionicons
            name={permissionDenied ? 'mic-off-outline' : 'mic-outline'}
            size={24}
            color={permissionDenied ? colors.destructive : colors.textSecondary}
          />
        )}
      </TouchableOpacity>
      {permissionDenied && (
        <Text
          style={{
            fontSize: 12,
            color: colors.destructive,
            textAlign: 'center',
            marginTop: 4,
          }}
        >
          Microphone access required. Enable in Settings.
        </Text>
      )}
    </View>
  )
}
