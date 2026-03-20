import { Stack } from 'expo-router'

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="phone" />
      <Stack.Screen name="verify" />
      <Stack.Screen name="canvas" />
      <Stack.Screen name="google" />
      <Stack.Screen name="tcpa" />
      <Stack.Screen name="preview" />
    </Stack>
  )
}
