import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { supabase } from '@/lib/supabase'

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({ phone: '+15551234567' }),
}))

// Mock supabase
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      getSession: jest.fn(() => ({
        data: { session: { user: { id: 'user-123', phone: '+15551234567' }, access_token: 'tok' } },
      })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => ({ data: null, error: null })),
    })),
  },
}))

// Mock lib/theme
jest.mock('@/lib/theme', () => ({
  useTheme: () => ({
    accent: '#6C47FF',
    colors: {
      dominant: '#fff',
      textPrimary: '#000',
      textSecondary: '#888',
      cardBorder: '#ddd',
      secondary: '#f9f9f9',
    },
  }),
}))

const mockSignInWithOtp = supabase.auth.signInWithOtp as jest.Mock
const mockVerifyOtp = supabase.auth.verifyOtp as jest.Mock

// ── Auth screen ──────────────────────────────────────────────────────────────

import Auth from '@/app/(onboarding)/auth'

describe('Auth screen — phone entry', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders phone input and disabled Send Code button', () => {
    const { getByPlaceholderText, getByText } = render(<Auth />)
    expect(getByPlaceholderText('+1 (555) 000-0000')).toBeTruthy()
    expect(getByText('Send code')).toBeTruthy()
  })

  it('Send Code button is disabled with fewer than 10 digits', () => {
    const { getByPlaceholderText, getByTestId } = render(<Auth />)
    // Input 6 raw digits — PhoneInput formats them but not to a full number
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '555123')
    expect(getByTestId('send-code-btn').props.accessibilityState?.disabled).toBe(true)
  })

  it('calls supabase.auth.signInWithOtp with E.164 phone on valid submit', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByPlaceholderText, getByText } = render(<Auth />)
    // Input 10 raw digits — PhoneInput formats to '+1 (555) 123-4567'
    // Auth's toE164 strips non-digits ('15551234567') and takes last 10 → '+15551234567'
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '5551234567')
    fireEvent.press(getByText('Send code'))

    await waitFor(() => {
      expect(mockSignInWithOtp).toHaveBeenCalledWith({ phone: '+15551234567' })
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(onboarding)/verify-phone',
        params: { phone: '+15551234567' },
      })
    })
  })

  it('shows error when signInWithOtp fails', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: { message: 'SMS quota exceeded' } })
    const { getByPlaceholderText, getByText, findByText } = render(<Auth />)
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '5551234567')
    fireEvent.press(getByText('Send code'))
    expect(await findByText(/couldn't send/i)).toBeTruthy()
  })
})

// ── VerifyPhone screen ───────────────────────────────────────────────────────

import VerifyPhone from '@/app/(onboarding)/verify-phone'

describe('VerifyPhone screen — Supabase OTP', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders the PIN input and phone number', () => {
    const { getByText } = render(<VerifyPhone />)
    expect(getByText(/\+15551234567/)).toBeTruthy()
  })

  it('calls supabase.auth.verifyOtp with phone and code on 6 digits', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByTestId } = render(<VerifyPhone />)
    fireEvent(getByTestId('pin-input'), 'complete', '123456')

    await waitFor(() => {
      expect(mockVerifyOtp).toHaveBeenCalledWith({
        phone: '+15551234567',
        token: '123456',
        type: 'sms',
      })
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/profile')
    })
  })

  it('shows error when verifyOtp fails', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })
    const { getByTestId, findByText } = render(<VerifyPhone />)
    fireEvent(getByTestId('pin-input'), 'complete', '999999')
    expect(await findByText(/didn't match|expired/i)).toBeTruthy()
  })
})

// ── Profile screen ───────────────────────────────────────────────────────────

import Profile from '@/app/(onboarding)/profile'
import { api } from '@/lib/api'

jest.mock('@/lib/api', () => ({
  api: {
    saveProfile: jest.fn(),
  },
}))

const mockSaveProfile = api.saveProfile as jest.Mock

describe('Profile screen — no phone field', () => {
  beforeEach(() => jest.clearAllMocks())

  it('does NOT render a phone number input', () => {
    const { queryByPlaceholderText } = render(<Profile />)
    expect(queryByPlaceholderText('+1 (555) 000-0000')).toBeNull()
  })

  it('renders name, university, graduation year fields', () => {
    const { getByPlaceholderText } = render(<Profile />)
    expect(getByPlaceholderText('Your name')).toBeTruthy()
    expect(getByPlaceholderText('e.g. Yale University')).toBeTruthy()
    expect(getByPlaceholderText('e.g. 2027')).toBeTruthy()
  })

  it('Continue button disabled without all fields', () => {
    const { getByText } = render(<Profile />)
    const btn = getByText('Continue')
    expect(btn.parent?.props.disabled).toBeTruthy()
  })

  it('calls api.saveProfile with name, university, graduation_year only (no phone)', async () => {
    mockSaveProfile.mockResolvedValue({ ok: true })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByPlaceholderText, getByText } = render(<Profile />)
    fireEvent.changeText(getByPlaceholderText('Your name'), 'Alice')
    fireEvent.changeText(getByPlaceholderText('e.g. Yale University'), 'Yale University')
    fireEvent.changeText(getByPlaceholderText('e.g. 2027'), '2027')
    fireEvent.press(getByText('Continue'))

    await waitFor(() => {
      expect(mockSaveProfile).toHaveBeenCalledWith({
        name: 'Alice',
        university: 'Yale University',
        graduation_year: 2027,
      })
      expect(mockSaveProfile).not.toHaveBeenCalledWith(
        expect.objectContaining({ phone: expect.anything() }),
      )
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/tcpa')
    })
  })
})
