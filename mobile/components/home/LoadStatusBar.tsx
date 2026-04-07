import React from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { useTheme } from '@/lib/theme'

type LoadLevel = 'light' | 'busy' | 'heavy'

type LoadStatusBarProps = {
  level: LoadLevel
  deadlineCount: number
  onPress?: () => void
}

const LEVEL_CONFIG: Record<LoadLevel, { shortLabel: string; specificMessage: string }> = {
  light: {
    shortLabel: 'Light week',
    specificMessage: 'Nothing urgent · enjoy the breathing room',
  },
  busy: {
    shortLabel: 'Busy week',
    specificMessage: 'CPSC 323 Problem Set due Thursday',
  },
  heavy: {
    shortLabel: 'Heavy week',
    specificMessage: 'ECON 121 midterm in 3 days · 30% of grade',
  },
}

/**
 * Zone 2 — LoadStatusBar
 * Full-width color-coded bar showing weekly load with a specific deadline callout.
 * Shows "Canvas · synced X min ago" underneath for trust-building.
 */
export function LoadStatusBar({ level, deadlineCount, onPress }: LoadStatusBarProps) {
  const { accent } = useTheme()
  const { shortLabel, specificMessage } = LEVEL_CONFIG[level]
  const plural = deadlineCount === 1 ? '' : 's'

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={{
        backgroundColor: accent,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      {/* Primary row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#FFFFFF' }}>
          {shortLabel} · {deadlineCount} deadline{plural}
        </Text>
        <View style={{
          backgroundColor: 'rgba(255,255,255,0.2)',
          paddingHorizontal: 9, paddingVertical: 3,
          borderRadius: 10,
        }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#FFFFFF' }}>This week</Text>
        </View>
      </View>

      {/* Specific deadline callout */}
      <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)', marginTop: 3 }}>
        {specificMessage}
      </Text>

      {/* Sync timestamp */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5, gap: 5 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.7)' }} />
        <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
          Canvas · synced 4 min ago
        </Text>
      </View>
    </TouchableOpacity>
  )
}
