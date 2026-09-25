import React from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

type QuickAccessBarProps = {
  onPressTodo?: () => void
  onPressNotifications?: () => void
}

const DEMO_USER = 'Daniel'

export function QuickAccessBar({ onPressTodo, onPressNotifications }: QuickAccessBarProps) {
  const { colors, accent } = useTheme()

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <View style={{
      backgroundColor: colors.dominant,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 10,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: colors.cardBorder,
    }}>
      {/* Left — greeting */}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.textPrimary }}>
          {greeting}, {DEMO_USER}
        </Text>
        <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>
          {dateLabel}
        </Text>
      </View>

      {/* Right — action icons */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <TouchableOpacity
          onPress={onPressTodo}
          style={{ width: 40, height: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 20 }}
          accessibilityLabel="Aria Personality"
        >
          <Ionicons name="person-circle-outline" size={26} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onPressNotifications}
          style={{ width: 40, height: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 20 }}
          accessibilityLabel="Notifications"
        >
          <Ionicons name="notifications-outline" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  )
}
