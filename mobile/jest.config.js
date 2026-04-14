module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.globals.js'],
  setupFilesAfterEnv: ['./jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|nativewind|react-native-reanimated|react-native-gesture-handler|react-native-draggable-flatlist|@gorhom))',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Prevent Expo's import.meta polyfill from failing in Jest:
    // ImportMetaRegistry is required lazily by installGlobal's __ExpoImportMetaRegistry
    // getter, which fires during render and fails because dynamic require() is out of
    // Jest's module scope. Mapping it to an empty object stops the cascade.
    '^expo/src/winter/ImportMetaRegistry$': '<rootDir>/__mocks__/empty.js',
  },
}
