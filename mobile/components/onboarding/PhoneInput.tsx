import React from 'react'
import { View, TextInput, Text } from 'react-native'
import { useTheme } from '@/lib/theme'

interface PhoneInputProps {
  value: string
  onChangeText: (text: string) => void
  isValid: boolean
  error?: string
}

/**
 * Phone number input field with US formatting and validation state styling.
 * Strips non-digits and auto-formats as user types.
 * Border color indicates state: default (cardBorder), invalid (red), valid (accent).
 */
export default function PhoneInput({ value, onChangeText, isValid, error }: PhoneInputProps) {
  const { accent, colors } = useTheme()

  const getBorderColor = () => {
    if (error) return '#FF3B30'
    if (isValid) return accent
    return colors.cardBorder
  }

  /**
   * Strips non-digit characters and applies basic US phone formatting.
   * e.g. "5551234567" → "+1 (555) 123-4567"
   */
  const formatPhone = (raw: string): string => {
    const digits = raw.replace(/\D/g, '')
    if (digits.length === 0) return ''
    if (digits.length <= 3) return `+1 (${digits}`
    if (digits.length <= 6) return `+1 (${digits.slice(0, 3)}) ${digits.slice(3)}`
    if (digits.length <= 10) return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`
  }

  const handleChangeText = (text: string) => {
    const digits = text.replace(/\D/g, '')
    const formatted = formatPhone(digits)
    onChangeText(formatted)
  }

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={handleChangeText}
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={15}
        placeholder="+1 (555) 000-0000"
        placeholderTextColor={colors.textSecondary}
        style={{
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
      {error ? (
        <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 6 }}>{error}</Text>
      ) : null}
    </View>
  )
}
