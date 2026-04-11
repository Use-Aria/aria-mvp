import { Stack } from 'expo-router'

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="verify-phone" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="tcpa" />
      <Stack.Screen name="tools" />
      <Stack.Screen name="success" />
    </Stack>
  )
}
