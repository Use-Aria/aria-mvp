import { useState } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, Modal, Switch
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Persona = 'friend' | 'coach' | 'parent' | 'mentor'
export type Tone = 'straightforward' | 'balanced' | 'encouraging'
export type CheckInFrequency = 'light' | 'normal' | 'active'

export type AriaPersonality = {
  persona: Persona
  tone: Tone
  checkins: CheckInFrequency
  deadlineWarnings: boolean
  gradeAlerts: boolean
  quietStart: string
  quietEnd: string
}

export const DEFAULT_PERSONALITY: AriaPersonality = {
  persona: 'friend',
  tone: 'balanced',
  checkins: 'normal',
  deadlineWarnings: true,
  gradeAlerts: true,
  quietStart: '10:00 PM',
  quietEnd: '8:00 AM',
}

// ── Data ───────────────────────────────────────────────────────────────────────

const PERSONAS: { key: Persona; label: string; description: string }[] = [
  {
    key: 'friend',
    label: 'Friend',
    description: 'Casual, supportive, keeps it real with you',
  },
  {
    key: 'coach',
    label: 'Coach',
    description: 'Direct, motivating, holds you accountable',
  },
  {
    key: 'parent',
    label: 'Parent',
    description: 'Thorough, caring, makes sure nothing slips',
  },
  {
    key: 'mentor',
    label: 'Mentor',
    description: 'Strategic, thoughtful, eyes on the big picture',
  },
]

const TONES: { key: Tone; label: string; sublabel: string }[] = [
  { key: 'straightforward', label: 'Straightforward', sublabel: 'Just the facts, no filler' },
  { key: 'balanced', label: 'Balanced', sublabel: 'Information with a bit of warmth' },
  { key: 'encouraging', label: 'Encouraging', sublabel: 'Positive reinforcement throughout' },
]

const CHECKINS: { key: CheckInFrequency; label: string; sublabel: string; icon: any }[] = [
  { key: 'light', label: 'Light', sublabel: 'Morning briefing only', icon: 'sunny-outline' },
  { key: 'normal', label: 'Normal', sublabel: 'Morning + evening check-in', icon: 'partly-sunny-outline' },
  { key: 'active', label: 'Active', sublabel: 'Morning, midday, evening + nudges', icon: 'notifications-outline' },
]

const QUIET_START_OPTIONS = ['8:00 PM', '9:00 PM', '10:00 PM', '11:00 PM', 'Midnight']
const QUIET_END_OPTIONS = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM']

// ── Preview message ────────────────────────────────────────────────────────────

function previewMessage(p: AriaPersonality): string {
  const { persona, tone } = p
  if (persona === 'friend') {
    if (tone === 'straightforward') return '"ECON midterm Friday, 30% of your grade. You good?"'
    if (tone === 'encouraging') return '"You have got this. ECON midterm Friday — I blocked Thursday evening for you."'
    return '"Heads up — ECON midterm Friday. Want me to block some study time?"'
  }
  if (persona === 'coach') {
    if (tone === 'straightforward') return '"ECON midterm Friday. 30%. No excuses — start tonight."'
    if (tone === 'encouraging') return '"Big week. ECON midterm Friday — this is where it counts. I blocked Thursday. Use it."'
    return '"ECON midterm Friday, worth 30%. Thursday evening is cleared. I expect you to use it."'
  }
  if (persona === 'parent') {
    if (tone === 'straightforward') return '"Your ECON midterm is Friday. Have you started studying? I have set reminders."'
    if (tone === 'encouraging') return '"I know you have been working hard. ECON midterm Friday — I will remind you at 3pm and again at 7pm."'
    return '"Do not forget — ECON midterm Friday. I have blocked study time and set three reminders. You are prepared."'
  }
  if (tone === 'straightforward') return '"ECON midterm Friday, 30% weight. Prioritize conceptual review over rereading notes."'
  if (tone === 'encouraging') return '"ECON midterm Friday. Understanding the frameworks is what separates good grades from great ones."'
  return '"ECON midterm Friday. I would spend Thursday on practice problems, not re-reading. Want a study plan?"'
}

// ── Component ──────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean
  onClose: () => void
  personality: AriaPersonality
  onChange: (p: AriaPersonality) => void
}

export function PersonalitySheet({ visible, onClose, personality, onChange }: Props) {
  const { colors, accent } = useTheme()
  const [local, setLocal] = useState<AriaPersonality>(personality)

  const update = (patch: Partial<AriaPersonality>) =>
    setLocal((prev) => ({ ...prev, ...patch }))

  const save = () => {
    onChange(local)
    onClose()
  }

  const SectionLabel = ({ text }: { text: string }) => (
    <Text style={{
      fontSize: 12, fontWeight: '700', letterSpacing: 0.6,
      color: colors.textSecondary, textTransform: 'uppercase',
      marginBottom: 10, marginTop: 4,
    }}>
      {text}
    </Text>
  )

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>

        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 16, paddingVertical: 14,
          borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
        }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
            <Ionicons name="close" size={24} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 20, fontWeight: '700', color: colors.textPrimary }}>
            Aria's Personality
          </Text>
          <TouchableOpacity
            onPress={save}
            style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: accent }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#FFFFFF' }}>Save</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

          {/* ── Persona ── */}
          <SectionLabel text="Persona" />
          <View style={{ gap: 8, marginBottom: 24 }}>
            {PERSONAS.map((p) => {
              const active = local.persona === p.key
              return (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => update({ persona: p.key })}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 14,
                    padding: 14, borderRadius: 12,
                    backgroundColor: active ? `${accent}10` : colors.secondary,
                    borderWidth: active ? 1.5 : 1,
                    borderColor: active ? accent : colors.cardBorder,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: active ? accent : colors.textPrimary }}>
                      {p.label}
                    </Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                      {p.description}
                    </Text>
                  </View>
                  {active && <Ionicons name="checkmark-circle" size={20} color={accent} />}
                </TouchableOpacity>
              )
            })}
          </View>

          {/* ── Tone ── */}
          <SectionLabel text="Tone" />
          <View style={{
            borderRadius: 12, overflow: 'hidden',
            borderWidth: 1, borderColor: colors.cardBorder,
            marginBottom: 24,
          }}>
            {TONES.map((t, i) => {
              const active = local.tone === t.key
              return (
                <TouchableOpacity
                  key={t.key}
                  onPress={() => update({ tone: t.key })}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    padding: 14,
                    backgroundColor: active ? `${accent}10` : colors.secondary,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: colors.cardBorder,
                  }}
                >
                  <View style={{
                    width: 20, height: 20, borderRadius: 10,
                    borderWidth: 2, borderColor: active ? accent : colors.textSecondary,
                    backgroundColor: active ? accent : 'transparent',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    {active && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' }} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: active ? accent : colors.textPrimary }}>
                      {t.label}
                    </Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{t.sublabel}</Text>
                  </View>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* ── Check-in Frequency ── */}
          <SectionLabel text="Check-in Frequency" />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
            {CHECKINS.map((c) => {
              const active = local.checkins === c.key
              return (
                <TouchableOpacity
                  key={c.key}
                  onPress={() => update({ checkins: c.key })}
                  style={{
                    flex: 1, alignItems: 'center', gap: 6,
                    paddingVertical: 14, paddingHorizontal: 8,
                    borderRadius: 12,
                    backgroundColor: active ? `${accent}10` : colors.secondary,
                    borderWidth: active ? 1.5 : 1,
                    borderColor: active ? accent : colors.cardBorder,
                  }}
                >
                  <Ionicons name={c.icon} size={20} color={active ? accent : colors.textSecondary} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: active ? accent : colors.textPrimary }}>
                    {c.label}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, textAlign: 'center', lineHeight: 15 }}>
                    {c.sublabel}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* ── Quiet Hours ── */}
          <SectionLabel text="Quiet Hours" />
          <View style={{
            borderRadius: 12,
            borderWidth: 1, borderColor: colors.cardBorder,
            overflow: 'hidden',
            marginBottom: 24,
          }}>
            {/* Do not disturb from */}
            <View style={{
              padding: 14, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
              backgroundColor: colors.secondary,
            }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 10 }}>
                DO NOT DISTURB FROM
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {QUIET_START_OPTIONS.map((t) => {
                  const active = local.quietStart === t
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => update({ quietStart: t })}
                      style={{
                        paddingHorizontal: 14, paddingVertical: 7,
                        borderRadius: 20,
                        backgroundColor: active ? accent : colors.dominant,
                        borderWidth: 1,
                        borderColor: active ? accent : colors.cardBorder,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#FFFFFF' : colors.textSecondary }}>
                        {t}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>

            {/* Until */}
            <View style={{ padding: 14, backgroundColor: colors.secondary }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 10 }}>
                UNTIL
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {QUIET_END_OPTIONS.map((t) => {
                  const active = local.quietEnd === t
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => update({ quietEnd: t })}
                      style={{
                        paddingHorizontal: 14, paddingVertical: 7,
                        borderRadius: 20,
                        backgroundColor: active ? accent : colors.dominant,
                        borderWidth: 1,
                        borderColor: active ? accent : colors.cardBorder,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#FFFFFF' : colors.textSecondary }}>
                        {t}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          </View>

          {/* ── Alerts ── */}
          <SectionLabel text="Alerts" />
          <View style={{
            borderRadius: 12, overflow: 'hidden',
            borderWidth: 1, borderColor: colors.cardBorder,
            marginBottom: 24,
          }}>
            {[
              { key: 'deadlineWarnings' as const, label: 'Deadline warnings', sub: 'Text me when a due date is within 24 hours' },
              { key: 'gradeAlerts' as const, label: 'High-stakes alerts', sub: 'Extra nudge for anything worth 20% or more' },
            ].map((item, i) => (
              <View key={item.key} style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                padding: 14,
                backgroundColor: colors.secondary,
                borderTopWidth: i > 0 ? 1 : 0,
                borderTopColor: colors.cardBorder,
              }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textPrimary }}>{item.label}</Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{item.sub}</Text>
                </View>
                <Switch
                  value={local[item.key]}
                  onValueChange={(v) => update({ [item.key]: v })}
                  trackColor={{ false: colors.cardBorder, true: accent }}
                  thumbColor="#FFFFFF"
                />
              </View>
            ))}
          </View>

          {/* ── Live preview ── */}
          <SectionLabel text="Message Preview" />
          <View style={{
            padding: 16, borderRadius: 12,
            backgroundColor: `${accent}10`,
            borderWidth: 1.5, borderColor: `${accent}25`,
          }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: accent, marginBottom: 8, letterSpacing: 0.4 }}>
              HOW ARIA WOULD TEXT YOU
            </Text>
            <Text style={{ fontSize: 15, color: colors.textPrimary, lineHeight: 22 }}>
              {previewMessage(local)}
            </Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 8 }}>
              Quiet hours active {local.quietStart} – {local.quietEnd}
            </Text>
          </View>

        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}
