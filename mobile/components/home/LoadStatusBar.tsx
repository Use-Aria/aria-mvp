import React from 'react'
import { View, Text, TouchableOpacity, Animated } from 'react-native'
import { STATUS_COLORS } from '@/lib/theme'

type LoadLevel = 'light' | 'busy' | 'heavy'

type LoadStatusBarProps = {
  level: LoadLevel
  deadlineCount: number
  onPress?: () => void
}

const LEVEL_CONFIG: Record<LoadLevel, { color: string; label: string }> = {
  light: { color: STATUS_COLORS.green, label: 'Light week' },
  busy: { color: STATUS_COLORS.yellow, label: 'Busy week' },
  heavy: { color: STATUS_COLORS.red, label: 'Heavy week' },
}

/**
 * Zone 2 — LoadStatusBar
 * Full-width 44px color-coded bar (green/yellow/red) showing weekly deadline density.
 * Tapping expands an inline breakdown view that slides down.
 * This is the PRIMARY focal point of the home screen.
 */
export function LoadStatusBar({ level, deadlineCount, onPress }: LoadStatusBarProps) {
  const [expanded, setExpanded] = React.useState(false)
  const expandAnim = React.useRef(new Animated.Value(0)).current

  const { color, label } = LEVEL_CONFIG[level]
  const plural = deadlineCount === 1 ? '' : 's'
  const barLabel = `${label} \u00B7 ${deadlineCount} deadline${plural}`

  const handlePress = () => {
    const toValue = expanded ? 0 : 1
    Animated.timing(expandAnim, {
      toValue,
      duration: 200,
      useNativeDriver: false,
    }).start()
    setExpanded(!expanded)
    onPress?.()
  }

  const expandedHeight = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 80],
  })

  return (
    <View>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.9}
        style={{
          height: 44,
          backgroundColor: color,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 14,
            fontWeight: '400',
            color: '#FFFFFF',
          }}
        >
          {barLabel}
        </Text>
      </TouchableOpacity>

      <Animated.View
        style={{
          height: expandedHeight,
          overflow: 'hidden',
          backgroundColor: color,
          opacity: 0.85,
          paddingHorizontal: 16,
          justifyContent: 'center',
        }}
      >
        {/* Expanded breakdown — real data wired when API provides per-course counts */}
        <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 4 }}>
          {deadlineCount} deadline{plural} this week
        </Text>
        <Text style={{ color: '#FFFFFF', fontSize: 13, opacity: 0.85 }}>
          Tap cards below to see details
        </Text>
      </Animated.View>
    </View>
  )
}
