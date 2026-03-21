import React from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { useTheme } from '@/lib/theme'

type PlaceholderCardProps = {
  title: string
  ctaText: string
  onPress: () => void
}

/**
 * Greyed-out placeholder card for unconnected integrations.
 * Renders a 72px tall card (matching collapsed DeadlineCard height)
 * with an accent-colored CTA to trigger the integration connect flow.
 *
 * Pre-configured instances used in CardGrid:
 * - Google Calendar: title="Connect Google to see your calendar", ctaText="Connect ->"
 * - Gmail: title="Connect Gmail to catch professor updates", ctaText="Connect ->"
 */
export function PlaceholderCard({ title, ctaText, onPress }: PlaceholderCardProps) {
  const { colors, accent } = useTheme()

  return (
    <View
      style={{
        height: 72,
        borderRadius: 12,
        padding: 16,
        backgroundColor: colors.secondary,
        borderWidth: 1,
        borderColor: colors.cardBorder,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Text
        style={{
          fontSize: 14,
          color: colors.textSecondary,
          flex: 1,
          marginRight: 12,
        }}
        numberOfLines={2}
      >
        {title}
      </Text>
      <TouchableOpacity onPress={onPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text
          style={{
            fontSize: 14,
            color: accent,
            fontWeight: '600',
          }}
        >
          {ctaText}
        </Text>
      </TouchableOpacity>
    </View>
  )
}
