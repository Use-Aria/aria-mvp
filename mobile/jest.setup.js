// Extend RNTL's waitFor timeout and Jest's test timeout so async state updates
// in act() contexts have enough time to flush when multiple test renders are active.
import { configure } from '@testing-library/react-native'
configure({ asyncUtilTimeout: 10000 })
jest.setTimeout(15000)

jest.mock('expo-secure-store')
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}))
jest.mock('@gorhom/bottom-sheet', () => ({
  __esModule: true,
  default: 'BottomSheet',
  BottomSheetModal: 'BottomSheetModal',
  BottomSheetModalProvider: ({ children }) => children,
  BottomSheetView: 'BottomSheetView',
  useBottomSheetModal: () => ({ dismiss: jest.fn(), present: jest.fn() }),
}))
