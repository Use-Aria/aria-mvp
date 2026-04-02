import React, { createContext, useContext, useState } from 'react'
import { useColorScheme } from 'react-native'

/**
 * 6 accent color presets. Indigo (#5856D6) is the default.
 * User selection stored in users.preferences_json.accent_color.
 */
export const ACCENT_COLORS = {
  Indigo: '#5856D6',
  Blue: '#007AFF',
  Green: '#16A34A',
  Orange: '#FF9500',
  Pink: '#FF2D55',
  Purple: '#AF52DE',
} as const

export type AccentColorName = keyof typeof ACCENT_COLORS

/** Load status bar colors — separate from accent, not user-configurable */
export const STATUS_COLORS = {
  green: '#2D9E4F',
  yellow: '#C8860A',
  red: '#D93025',
} as const

/** Full palette for light and dark modes */
export const COLORS = {
  light: {
    dominant: '#FFFFFF',
    secondary: '#F4FBF4',
    textPrimary: '#0A0A0A',
    textSecondary: '#6B7280',
    destructive: '#DC2626',
    cardBorder: '#E2F0E2',
  },
  dark: {
    dominant: '#0A120A',
    secondary: '#111D11',
    textPrimary: '#F0FFF0',
    textSecondary: '#6B9B6B',
    destructive: '#FF453A',
    cardBorder: '#1E3A1E',
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
  accent: ACCENT_COLORS.Green,
  accentName: 'Green',
  setAccent: () => {},
  colors: COLORS.light as typeof COLORS.light | typeof COLORS.dark,
  isDark: false,
})

/** Access the current theme (accent color, palette, dark mode flag) */
export const useTheme = () => useContext(ThemeContext)
