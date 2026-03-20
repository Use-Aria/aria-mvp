import { View, Text, TouchableOpacity } from 'react-native'
import { useRouter } from 'expo-router'
import { useTheme } from '@/lib/theme'

export default function Welcome() {
  const router = useRouter()
  const { accent } = useTheme()
  return (
    <View className="flex-1 justify-center items-center bg-white dark:bg-black px-8">
      <Text className="text-[28px] font-semibold text-black dark:text-white mb-4">
        Meet Aria
      </Text>
      <Text className="text-base text-gray-500 dark:text-gray-400 text-center mb-12">
        Your AI assistant for deadlines, classes, and everything in between.
      </Text>
      <TouchableOpacity
        style={{ backgroundColor: accent, borderRadius: 12, paddingVertical: 16, width: '100%', alignItems: 'center' }}
        onPress={() => router.push('/(onboarding)/phone')}
      >
        <Text className="text-white font-semibold text-base">Get started</Text>
      </TouchableOpacity>
    </View>
  )
}
