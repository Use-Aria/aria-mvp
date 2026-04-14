import React from 'react'
import { View, TextInput, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

type ValidationStatus = 'idle' | 'validating' | 'valid' | 'error'

interface CanvasUrlInputProps {
  value: string
  onChangeText: (text: string) => void
  onValidate: () => void
  status: ValidationStatus
  errorMessage?: string
}

/**
 * Canvas iCal URL input with inline Validate button and validation state feedback.
 * Client-side regex checks for webcal:// or https:// before calling onValidate.
 * Border color indicates state: idle (cardBorder), validating (accent), valid (green), error (red).
 */
export default function CanvasUrlInput({
  value,
  onChangeText,
  onValidate,
  status,
  errorMessage,
}: CanvasUrlInputProps) {
  const { accent, colors } = useTheme()

  const getBorderColor = (): string => {
    switch (status) {
      case 'validating': return accent
      case 'valid': return '#34C759'
      case 'error': return '#FF3B30'
      default: return colors.cardBorder
    }
  }

  const getButtonBackground = (): string => {
    if (status === 'valid') return '#34C759'
    return accent
  }

  const handleValidate = () => {
    onValidate()
  }

  const renderButtonContent = () => {
    switch (status) {
      case 'validating':
        return <ActivityIndicator color="#FFFFFF" size="small" />
      case 'valid':
        return <Ionicons name="checkmark" size={20} color="#FFFFFF" />
      default:
        return (
          <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>
            {status === 'error' ? 'Retry' : 'Validate'}
          </Text>
        )
    }
  }

  // Validated — show success row (same pattern as Google "Connected" state)
  if (status === 'valid') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="checkmark-circle" size={20} color="#34C759" />
        <Text style={{ flex: 1, fontSize: 15, color: '#34C759', fontWeight: '600' }}>
          Connected
        </Text>
        <TouchableOpacity onPress={() => onChangeText('')}>
          <Text style={{ fontSize: 14, color: accent }}>Change</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Paste your Canvas iCal URL"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={{
            flex: 1,
            height: 56,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 16,
            fontSize: 16,
            borderColor: getBorderColor(),
            color: colors.textPrimary,
            backgroundColor: colors.dominant,
          }}
        />
        <TouchableOpacity
          onPress={handleValidate}
          disabled={status === 'validating' || !value.trim()}
          style={{
            backgroundColor: getButtonBackground(),
            borderRadius: 12,
            paddingHorizontal: 16,
            height: 56,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
            opacity: status === 'validating' || !value.trim() ? 0.6 : 1,
          }}
        >
          {renderButtonContent()}
        </TouchableOpacity>
      </View>
      {status === 'error' && errorMessage ? (
        <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 6 }}>{errorMessage}</Text>
      ) : null}
    </View>
  )
}
