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
      single: jest.fn(() => ({ data: null, error: null })),
    })),
  },
}))

// Mock expo-web-browser
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
}))

// Mock expo-document-picker
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}))

// Mock ProgressBar (no-op)
jest.mock('@/components/onboarding/ProgressBar', () => () => null)

// Mock UniversityPicker — calls onChange('Yale University') when pressed
jest.mock('@/components/onboarding/UniversityPicker', () => {
  const { TouchableOpacity, Text } = require('react-native')
  return function MockUniversityPicker({ value, onChange, testID }) {
    return (
      <TouchableOpacity testID={testID || 'university-picker'} onPress={() => onChange('Yale University')}>
        <Text>{value || 'Select your university'}</Text>
      </TouchableOpacity>
    )
  }
})

// Mock CanvasUrlInput — renders a simple TextInput + Validate button for test control
jest.mock('@/components/onboarding/CanvasUrlInput', () => {
  const { TextInput, TouchableOpacity, Text } = require('react-native')
  return function MockCanvasUrlInput({
    value,
    onChangeText,
    onValidate,
    status,
  }: {
    value: string
    onChangeText: (t: string) => void
    onValidate: () => void
    status: string
  }) {
    if (status === 'valid') {
      return <Text>Connected</Text>
    }
    return (
      <>
        <TextInput
          testID="canvas-url-input"
          value={value}
          onChangeText={onChangeText}
        />
        <TouchableOpacity testID="canvas-validate-btn" onPress={onValidate}>
          <Text>Validate</Text>
        </TouchableOpacity>
      </>
    )
  }
})

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
    expect(await findByText(/couldn't send|SMS quota exceeded/i)).toBeTruthy()
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
  API_BASE: 'http://localhost:3000',
  api: {
    saveProfile: jest.fn(),
    validateCanvasUrl: jest.fn(),
  },
}))

const mockSaveProfile = api.saveProfile as jest.Mock

describe('Profile screen — no phone field', () => {
  beforeEach(() => jest.clearAllMocks())

  it('does NOT render a phone number input', () => {
    const { queryByPlaceholderText } = render(<Profile />)
    expect(queryByPlaceholderText('+1 (555) 000-0000')).toBeNull()
  })

  it('renders name, university picker, and graduation year fields', () => {
    const { getByPlaceholderText, getByTestId } = render(<Profile />)
    expect(getByPlaceholderText('Your name')).toBeTruthy()
    expect(getByTestId('university-picker')).toBeTruthy()
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

    const { getByPlaceholderText, getByTestId, getByText } = render(<Profile />)
    fireEvent.changeText(getByPlaceholderText('Your name'), 'Alice')
    fireEvent.press(getByTestId('university-picker')) // mock calls onChange('Yale University')
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

// ── TCPA screen ──────────────────────────────────────────────────────────────

import Tcpa from '@/app/(onboarding)/tcpa'

describe('TCPA screen — Option 2 (optional consent)', () => {
  const mockFrom = supabase.from as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    // Default: no existing preferences
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => ({ data: null, error: null })),
      update: jest.fn().mockReturnThis(),
    }))
  })

  it('shows warning message when toggle is OFF (default)', () => {
    const { getByText } = render(<Tcpa />)
    expect(
      getByText(/won't send morning briefings or deadline alerts/i),
    ).toBeTruthy()
  })

  it('hides warning message when toggle is turned ON', () => {
    const { getByRole, queryByText } = render(<Tcpa />)
    const toggle = getByRole('switch')
    fireEvent(toggle, 'valueChange', true)
    expect(
      queryByText(/won't send morning briefings or deadline alerts/i),
    ).toBeNull()
  })

  it('Continue button is enabled regardless of consent state', () => {
    const { getByText } = render(<Tcpa />)
    const btn = getByText('Continue')
    expect(btn.parent?.props.disabled).toBeFalsy()
  })

  it('navigates to tools after confirming with toggle OFF', async () => {
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush, replace: jest.fn() })

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => ({ data: null, error: null })),
      update: jest.fn(() => ({ eq: jest.fn(() => ({ error: null })) })),
    }))

    const { getByText } = render(<Tcpa />)
    fireEvent.press(getByText('Continue'))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/tools')
    })
  })

  it('navigates to tools after confirming with toggle ON', async () => {
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush, replace: jest.fn() })

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => ({ data: null, error: null })),
      update: jest.fn(() => ({ eq: jest.fn(() => ({ error: null })) })),
    }))

    const { getByText, getByRole } = render(<Tcpa />)
    fireEvent(getByRole('switch'), 'valueChange', true)
    fireEvent.press(getByText('Continue'))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/tools')
    })
  })
})

// ── Tools screen ─────────────────────────────────────────────────────────────

import Tools from '@/app/(onboarding)/tools'
import * as WebBrowser from 'expo-web-browser'
const mockOpenBrowser = WebBrowser.openBrowserAsync as jest.Mock
const mockValidateCanvasUrl = jest.mocked(api.validateCanvasUrl)

describe('Tools screen — Canvas guide', () => {
  const mockFrom = supabase.from as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    // Default: all DB queries return null (unknown school, no existing integrations)
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => ({ data: null, error: null })),
    }))
  })

  it('renders the Canvas guide when not yet connected', () => {
    const { getByText } = render(<Tools />)
    expect(getByText(/step 1/i)).toBeTruthy()
    expect(getByText(/step 2/i)).toBeTruthy()
    expect(getByText(/step 3/i)).toBeTruthy()
  })

  it('renders the "Open Canvas" button when not yet connected', () => {
    const { getByText } = render(<Tools />)
    expect(getByText('Open Canvas')).toBeTruthy()
  })

  it('disables "Open Canvas" and shows hint when school is unknown and no URL typed', async () => {
    const { getByText } = render(<Tools />)
    await waitFor(() => {
      expect(getByText(/paste your canvas url/i)).toBeTruthy()
    })
  })

  it('tapping "Open Canvas" uses university lookup for known school', async () => {
    mockFrom.mockImplementation((table: string) => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => ({
        data: table === 'users' ? { university: 'Yale University' } : null,
        error: null,
      })),
    }))
    mockOpenBrowser.mockResolvedValue(undefined)
    const { getByText, queryByText } = render(<Tools />)
    // Wait for university state to resolve — hint text disappears when domain is known
    await waitFor(() => {
      expect(queryByText(/paste your canvas url/i)).toBeNull()
    })
    fireEvent.press(getByText('Open Canvas'))
    await waitFor(() => {
      expect(mockOpenBrowser).toHaveBeenCalledWith('https://yale.instructure.com/calendar')
    })
  })

  it('tapping "Open Canvas" uses domain extracted from pasted iCal URL', async () => {
    mockOpenBrowser.mockResolvedValue(undefined)
    const { getByText, getByTestId } = render(<Tools />)
    fireEvent.changeText(getByTestId('canvas-url-input'), 'https://harvard.instructure.com/feeds/calendars/user_abc.ics')
    fireEvent.press(getByText('Open Canvas'))
    await waitFor(() => {
      expect(mockOpenBrowser).toHaveBeenCalledWith(
        'https://harvard.instructure.com/calendar',
      )
    })
  })

  it('URL domain takes priority over university lookup', async () => {
    mockFrom.mockImplementation((table: string) => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => ({
        data: table === 'users' ? { university: 'Yale' } : null,
        error: null,
      })),
    }))
    mockOpenBrowser.mockResolvedValue(undefined)
    const { getByText, getByTestId } = render(<Tools />)
    fireEvent.changeText(getByTestId('canvas-url-input'), 'https://mit.instructure.com/feeds/calendars/user_abc.ics')
    fireEvent.press(getByText('Open Canvas'))
    await waitFor(() => {
      expect(mockOpenBrowser).toHaveBeenCalledWith('https://mit.instructure.com/calendar')
    })
  })

  it('hides the guide and "Open Canvas" button when Canvas is connected', async () => {
    mockValidateCanvasUrl.mockResolvedValue({ deadline_count: 5, sample_courses: [] })
    const { getByTestId, queryByText } = render(<Tools />)
    fireEvent.changeText(getByTestId('canvas-url-input'), 'https://yale.instructure.com/feeds/calendars/user_abc.ics')
    fireEvent.press(getByTestId('canvas-validate-btn'))
    await waitFor(() => {
      expect(mockValidateCanvasUrl).toHaveBeenCalledWith(
        'https://yale.instructure.com/feeds/calendars/user_abc.ics',
      )
      expect(queryByText(/step 1/i)).toBeNull()
      expect(queryByText('Open Canvas')).toBeNull()
    })
  })
})
