import React, { createContext, useContext, useState } from 'react'
import { useColorScheme } from 'react-native'

/**
 * 6 accent color presets. Indigo (#5856D6) is the default.
 * User selection stored in users.preferences_json.accent_color.
 */
export const ACCENT_COLORS = {
  Indigo: '#5856D6',
  Blue: '#007AFF',
  Green: '#34C759',
  Orange: '#FF9500',
  Pink: '#FF2D55',
  Purple: '#AF52DE',
} as const

export type AccentColorName = keyof typeof ACCENT_COLORS

/** Load status bar colors — separate from accent, not user-configurable */
export const STATUS_COLORS = {
  green: '#34C759',
  yellow: '#FF9500',
  red: '#FF3B30',
} as const

/** Full palette for light and dark modes */
export const COLORS = {
  light: {
    dominant: '#FFFFFF',
    secondary: '#F2F2F7',
    textPrimary: '#000000',
    textSecondary: '#6E6E73',
    destructive: '#FF3B30',
    cardBorder: '#E5E5EA',
  },
  dark: {
    dominant: '#000000',
    secondary: '#1C1C1E',
    textPrimary: '#FFFFFF',
    textSecondary: '#98989D',
    destructive: '#FF453A',
    cardBorder: '#38383A',
  },
} as const

type ThemeContextType = {
  accent: string
  accentName: AccentColorName
  setAccent: (name: AccentColorName) => void
  colors: typeof COLORS.light | typeof COLORS.dark
  isDark: boolean
}

export const ThemeContext = createContext<ThemeContextType>({
  accent: ACCENT_COLORS.Indigo,
  accentName: 'Indigo',
  setAccent: () => {},
  colors: COLORS.light as typeof COLORS.light | typeof COLORS.dark,
  isDark: false,
})

/** Access the current theme (accent color, palette, dark mode flag) */
export const useTheme = () => useContext(ThemeContext)
