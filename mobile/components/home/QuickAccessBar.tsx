import React from 'react'
import { View, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

type QuickAccessBarProps = {
  onPressTodo?: () => void
  onPressCalendar?: () => void
  onPressNotifications?: () => void
}

/**
 * Zone 1 — QuickAccessBar
 * Fixed 56px bar with three icon buttons (To-Do, Calendar, Notifications).
 * Each icon has a 44x44 touch target and shows the accent color on press.
 */
export function QuickAccessBar({
  onPressTodo,
  onPressCalendar,
  onPressNotifications,
}: QuickAccessBarProps) {
  const { colors, accent } = useTheme()
  const [pressedIcon, setPressedIcon] = React.useState<string | null>(null)

  const iconColor = (name: string) =>
    pressedIcon === name ? accent : colors.textSecondary

  return (
    <View
      style={{
        height: 56,
        backgroundColor: colors.secondary,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingHorizontal: 16,
      }}
    >
      <TouchableOpacity
        accessibilityLabel="To-Do"
        style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
        onPress={onPressTodo}
        onPressIn={() => setPressedIcon('todo')}
        onPressOut={() => setPressedIcon(null)}
        activeOpacity={1}
      >
        <Ionicons name="checkmark-circle-outline" size={24} color={iconColor('todo')} />
      </TouchableOpacity>

      <TouchableOpacity
        accessibilityLabel="Calendar"
        style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
        onPress={onPressCalendar}
        onPressIn={() => setPressedIcon('calendar')}
        onPressOut={() => setPressedIcon(null)}
        activeOpacity={1}
      >
        <Ionicons name="calendar-outline" size={24} color={iconColor('calendar')} />
      </TouchableOpacity>

      <TouchableOpacity
        accessibilityLabel="Notifications"
        style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
        onPress={onPressNotifications}
        onPressIn={() => setPressedIcon('notifications')}
        onPressOut={() => setPressedIcon(null)}
        activeOpacity={1}
      >
        <Ionicons name="notifications-outline" size={24} color={iconColor('notifications')} />
      </TouchableOpacity>
    </View>
  )
}
