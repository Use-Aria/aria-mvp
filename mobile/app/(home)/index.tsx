import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function Home() {
  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-white dark:bg-black">
      <View className="flex-1 justify-center items-center">
        <Text className="text-[20px] font-semibold text-black dark:text-white">
          Home — placeholder
        </Text>
      </View>
    </SafeAreaView>
  )
}
