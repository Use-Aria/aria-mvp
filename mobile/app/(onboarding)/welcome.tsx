import { View, Text, TouchableOpacity } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

const STEPS = [
  {
    icon: 'school-outline' as const,
    title: 'Connect Canvas',
    description: 'Paste your iCal link — Aria imports all your deadlines instantly.',
  },
  {
    icon: 'mail-outline' as const,
    title: 'Link Gmail',
    description: 'Aria watches for professor emails so nothing slips through.',
  },
  {
    icon: 'chatbubble-ellipses-outline' as const,
    title: 'Get briefed by text',
    description: 'Every morning Aria texts you what matters most that day.',
  },
]

export default function Welcome() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  return (
    <View style={{ flex: 1, backgroundColor: colors.dominant, paddingHorizontal: 28 }}>

      {/* Hero */}
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: accent, letterSpacing: 1.2, marginBottom: 10 }}>
          ARIA · AI PERSONAL ASSISTANT
        </Text>
        <Text style={{ fontSize: 34, fontWeight: '800', color: colors.textPrimary, lineHeight: 40, marginBottom: 12 }}>
          Your Yale life,{'\n'}under control.
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 40 }}>
          Aria unifies your deadlines, inbox, and calendar into one daily SMS briefing. Setup takes 90 seconds.
        </Text>

        {/* Steps */}
        <View style={{ gap: 20 }}>
          {STEPS.map((step, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 16 }}>
              <View style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: `${accent}15`,
                alignItems: 'center', justifyContent: 'center',
                marginTop: 1,
              }}>
                <Ionicons name={step.icon} size={20} color={accent} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <Text style={{
                    width: 20, height: 20, borderRadius: 10,
                    backgroundColor: accent,
                    textAlign: 'center', lineHeight: 20,
                    fontSize: 11, fontWeight: '800', color: '#FFFFFF',
                    overflow: 'hidden',
                  }}>
                    {i + 1}
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textPrimary }}>
                    {step.title}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 19 }}>
                  {step.description}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* CTA */}
      <View style={{ paddingBottom: 48 }}>
        <TouchableOpacity
          style={{
            backgroundColor: accent,
            borderRadius: 14,
            paddingVertical: 17,
            alignItems: 'center',
            marginBottom: 14,
          }}
          onPress={() => router.push('/(onboarding)/auth')}
        >
          <Text style={{ fontSize: 16, fontWeight: '700', color: '#FFFFFF' }}>
            Get started — 90 seconds
          </Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>
          Yale students only · Closed beta
        </Text>
      </View>

    </View>
  )
}
