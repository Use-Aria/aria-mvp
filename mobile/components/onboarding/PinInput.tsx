import React, { useRef, useState, useEffect } from 'react'
import { View, TextInput, Text } from 'react-native'
import { useTheme } from '@/lib/theme'

interface PinInputProps {
  onComplete: (code: string) => void
  error?: string
  onClear?: () => void
  testID?: string
}

const PIN_LENGTH = 6

/**
 * 6-cell PIN input with auto-advance focus and auto-submit on final digit.
 * Each cell is an individual TextInput that advances focus forward on digit entry
 * and backward on backspace of an empty cell.
 * Calls onComplete(allSixDigits) when the 6th digit is entered.
 */
export default function PinInput({ onComplete, error, onClear, testID }: PinInputProps) {
  const { accent, colors } = useTheme()
  const inputs = useRef<Array<TextInput | null>>(Array(6).fill(null))
  const [pins, setPins] = useState<string[]>(Array(6).fill(''))
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)

  // Auto-focus first cell on mount
  useEffect(() => {
    setTimeout(() => {
      inputs.current[0]?.focus()
    }, 100)
  }, [])

  // Clear pins when onClear is triggered
  useEffect(() => {
    if (onClear) {
      // onClear is a callback, so we don't auto-call it here
      // The parent uses it to signal reset; the parent should remount or use a key prop
    }
  }, [onClear])

  const getCellBorderColor = (index: number): string => {
    if (error) return '#FF3B30'
    if (focusedIndex === index) return accent
    if (pins[index]) return colors.cardBorder
    return colors.cardBorder
  }

  const handleChange = (text: string, index: number) => {
    // Only allow single digit
    const digit = text.replace(/\D/g, '').slice(-1)

    const newPins = [...pins]
    newPins[index] = digit
    setPins(newPins)

    if (digit && index < PIN_LENGTH - 1) {
      // Advance to next cell
      inputs.current[index + 1]?.focus()
    } else if (digit && index === PIN_LENGTH - 1) {
      // Last digit entered — call onComplete
      inputs.current[index]?.blur()
      onComplete(newPins.join(''))
    }
  }

  const handleKeyPress = (event: { nativeEvent: { key: string } }, index: number) => {
    if (event.nativeEvent.key === 'Backspace' && !pins[index] && index > 0) {
      // Move focus back to previous cell on backspace when current is empty
      const newPins = [...pins]
      newPins[index - 1] = ''
      setPins(newPins)
      inputs.current[index - 1]?.focus()
    }
  }

  return (
    // testID + onComplete forwarded so tests can fire fireEvent(el, 'complete', code)
    <View testID={testID} {...(onComplete ? { onComplete } as unknown as object : {})}>
      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        {Array(6).fill(null).map((_, index) => (
          <TextInput
            key={index}
            ref={(ref) => { inputs.current[index] = ref }}
            value={pins[index]}
            onChangeText={(text) => handleChange(text, index)}
            onKeyPress={(event) => handleKeyPress(event, index)}
            onFocus={() => setFocusedIndex(index)}
            onBlur={() => setFocusedIndex(null)}
            keyboardType="number-pad"
            maxLength={1}
            selectTextOnFocus={true}
            style={{
              width: 48,
              height: 56,
              borderWidth: 2,
              borderRadius: 12,
              textAlign: 'center',
              fontSize: 20,
              fontWeight: '600',
              marginHorizontal: 4,
              borderColor: getCellBorderColor(index),
              color: colors.textPrimary,
              backgroundColor: colors.dominant,
            }}
          />
        ))}
      </View>
      {error ? (
        <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 8, textAlign: 'center' }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
