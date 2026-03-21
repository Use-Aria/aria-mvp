import React from 'react'
import { View } from 'react-native'
import { useTheme } from '@/lib/theme'

interface ProgressBarProps {
  currentStep: number
  totalSteps?: number
}

/**
 * 7-segment horizontal progress indicator for the onboarding wizard.
 * Active segments (index < currentStep) are filled with the user's accent color.
 * Inactive segments use cardBorder color from the current theme.
 * Not rendered on Step 1 (Welcome) — screens conditionally include this component.
 */
export default function ProgressBar({ currentStep, totalSteps = 7 }: ProgressBarProps) {
  const { accent, colors } = useTheme()

  return (
    <View
      style={{
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      {Array.from({ length: totalSteps }).map((_, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            height: 4,
            marginHorizontal: 2,
            borderRadius: 2,
            backgroundColor: index < currentStep ? accent : colors.cardBorder,
          }}
        />
      ))}
    </View>
  )
}
