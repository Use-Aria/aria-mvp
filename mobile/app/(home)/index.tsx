import { useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, Modal, TextInput, KeyboardAvoidingView, Platform, FlatList } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { QuickAccessBar } from '@/components/home/QuickAccessBar'
import { LoadStatusBar } from '@/components/home/LoadStatusBar'
import { StatsRings } from '@/components/home/StatsRings'
import { CardGrid } from '@/components/home/CardGrid'
import { ChatBar } from '@/components/home/ChatBar'
import { PersonalitySheet, DEFAULT_PERSONALITY } from '@/components/home/PersonalitySheet'
import type { AriaPersonality } from '@/components/home/PersonalitySheet'
import { useCards } from '@/hooks/useCards'
import { useTheme } from '@/lib/theme'

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_TODOS = [
  { id: '1', text: 'Email Prof. Smith about office hours', done: false },
  { id: '2', text: 'Review ECON 121 Chapter 8 notes', done: false },
  { id: '3', text: 'Submit CPSC 200 pre-lab', done: true },
  { id: '4', text: 'Print HIST 115 readings', done: false },
  { id: '5', text: 'Book study room for Thursday', done: true },
]

const MOCK_CALENDAR = [
  { id: '1', title: 'CPSC 323 Lecture', time: 'Today · 9:00 – 10:15 AM', location: 'AKW 200', type: 'class' },
  { id: '2', title: 'ECON 121 Section', time: 'Today · 1:00 – 2:00 PM', location: 'WLH 208', type: 'class' },
  { id: '3', title: 'Study Block — HIST 115 Paper', time: 'Today · 4:00 – 6:00 PM', location: 'Bass Library', type: 'study' },
  { id: '4', title: 'MATH 230 Lecture', time: 'Tomorrow · 10:30 – 11:45 AM', location: 'DL 220', type: 'class' },
  { id: '5', title: 'Study Block — ECON Review', time: 'Thu Apr 3 · 9:00 – 11:00 AM', location: 'Sterling Library', type: 'study' },
  { id: '6', title: 'ECON 121 Midterm', time: 'Fri Apr 4 · 2:00 – 4:00 PM', location: 'LC 102', type: 'exam' },
]

// SMS conversation — newest last (normal chat order)
const MOCK_SMS = [
  { id: 's1', from: 'aria', text: "Good morning! Heavy week — HIST paper due tomorrow, CPSC pset Thursday, ECON midterm Friday. Want your briefing?", time: '7:00 AM' },
  { id: 's2', from: 'user', text: 'yes', time: '7:01 AM' },
  { id: 's3', from: 'aria', text: "Today: CPSC 323 at 9am, section at 1pm. You're free 4–6pm — perfect for the HIST paper. Aim for a full draft tonight.", time: '7:01 AM' },
  { id: 's4', from: 'user', text: 'remind me at 3:30', time: '7:02 AM' },
  { id: 's5', from: 'aria', text: "Done. Reminder set for 3:30 PM. Also: Prof. Johnson moved Thursday office hours to 2pm.", time: '7:02 AM' },
  { id: 's6', from: 'user', text: 'push my econ study block to thursday morning', time: '7:04 AM' },
  { id: 's7', from: 'aria', text: "Done — moved ECON review to Thu 9–11am. Wednesday evening is now free. Good call.", time: '7:04 AM' },
]

const MOCK_NOTIFICATIONS = [
  { id: '1', icon: 'alert-circle' as const, text: 'Canvas updated: HIST 115 deadline moved to Apr 3', time: '2h ago' },
  { id: '2', icon: 'time' as const, text: 'Reminder: ECON 121 midterm in 3 days — 30% of your grade', time: '5h ago' },
  { id: '3', icon: 'sparkles' as const, text: 'Aria: You have a 2-hour gap Wednesday — perfect for your CPSC pset', time: '7am' },
  { id: '4', icon: 'mail' as const, text: 'Prof. Johnson moved Thursday office hours to 2pm', time: 'Yesterday' },
]

const EVENT_COLORS: Record<string, string> = {
  class: '#16A34A',
  study: '#5856D6',
  exam: '#DC2626',
}

type Tab = 'deadlines' | 'todos' | 'calendar' | 'sms'

// ── Component ──────────────────────────────────────────────────────────────────

export default function Home() {
  const { tasks, loading, loadLevel, hideCard, reorderCards } = useCards()
  const { colors, accent } = useTheme()

  const [activeTab, setActiveTab] = useState<Tab>('deadlines')
  const [todos, setTodos] = useState(MOCK_TODOS)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showPersonality, setShowPersonality] = useState(false)
  const [personality, setPersonality] = useState<AriaPersonality>(DEFAULT_PERSONALITY)
  const [showAddTodo, setShowAddTodo] = useState(false)
  const [newTodoText, setNewTodoText] = useState('')

  // ── Stats calculations ────────────────────────────────────────────────────
  const now = Date.now()
  const threeDays = 3 * 24 * 60 * 60 * 1000
  const sevenDays = 7 * 24 * 60 * 60 * 1000

  const urgent = tasks.filter((t) => {
    const due = new Date(t.due_date).getTime()
    return t.status === 'upcoming' && due >= now && due <= now + threeDays
  })
  // Academic: deadline pressure based on urgent assignments
  const academicPercent = 38
  // Commitments: % of this week's non-academic obligations accounted for
  const commitmentsPercent = 62
  // Capacity: remaining bandwidth (free time as % of available week)
  const capacityPercent = 42

  // ── Aria insight — pick most urgent task ─────────────────────────────────
  const mostUrgent = tasks
    .filter((t) => t.status === 'upcoming')
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0]

  const insightText = mostUrgent
    ? `Your ${mostUrgent.course} ${mostUrgent.title.split('—')[1]?.trim() ?? 'assignment'} is worth ${mostUrgent.weight ?? '?'}% and due ${new Date(mostUrgent.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}. I'd start tonight.`
    : "You're all caught up. Nice work."

  // ── Handlers ──────────────────────────────────────────────────────────────
  const toggleTodo = (id: string) =>
    setTodos((prev) => prev.map((t) => t.id === id ? { ...t, done: !t.done } : t))

  const addTodo = () => {
    const text = newTodoText.trim()
    if (!text) return
    setTodos((prev) => [{ id: `todo-${Date.now()}`, text, done: false }, ...prev])
    setNewTodoText('')
    setShowAddTodo(false)
  }

  const TABS: { key: Tab; label: string; icon: any }[] = [
    { key: 'deadlines', label: 'Deadlines', icon: 'flag-outline' },
    { key: 'todos', label: 'To-Do', icon: 'checkmark-circle-outline' },
    { key: 'calendar', label: 'Calendar', icon: 'calendar-outline' },
    { key: 'sms', label: 'SMS', icon: 'chatbubble-outline' },
  ]

  return (
    <View style={{ flex: 1, backgroundColor: colors.dominant }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>

        <QuickAccessBar
          onPressNotifications={() => setShowNotifications(true)}
          onPressTodo={() => setShowPersonality(true)}
        />

        <LoadStatusBar
          level={loadLevel}
          deadlineCount={tasks.filter((t) => t.status === 'upcoming').length}
        />

        <StatsRings
          academicPercent={academicPercent}
          commitmentsPercent={commitmentsPercent}
          capacityPercent={capacityPercent}
        />

        {/* Tab bar */}
        <View style={{
          flexDirection: 'row',
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 6,
          borderBottomWidth: 1,
          borderBottomColor: colors.cardBorder,
          backgroundColor: colors.dominant,
        }}>
          {TABS.map((tab) => {
            const active = activeTab === tab.key
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  paddingVertical: 7,
                  borderRadius: 10,
                  backgroundColor: active ? accent : colors.secondary,
                  borderWidth: 1,
                  borderColor: active ? accent : colors.cardBorder,
                }}
              >
                <Ionicons name={tab.icon} size={13} color={active ? '#FFFFFF' : colors.textSecondary} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#FFFFFF' : colors.textSecondary }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

        {/* Content */}
        <View style={{ flex: 1 }}>

          {/* ── Deadlines ── */}
          {activeTab === 'deadlines' && (
            <CardGrid
              tasks={tasks}
              loading={loading}
              onDone={() => {}}
              onSnooze={() => {}}
              onHide={hideCard}
              onReorder={reorderCards}
              ListHeaderComponent={
                <View style={{ gap: 8, paddingTop: 16 }}>
                  {/* Aria insight card */}
                  <View style={{
                    marginHorizontal: 16,
                    padding: 14, borderRadius: 14,
                    backgroundColor: `${accent}12`,
                    borderWidth: 1.5, borderColor: `${accent}30`,
                    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                  }}>
                    <View style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: accent,
                      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Text style={{ fontSize: 14, color: '#fff' }}>A</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: accent, marginBottom: 3, letterSpacing: 0.3 }}>
                        ARIA
                      </Text>
                      <Text style={{ fontSize: 14, color: colors.textPrimary, lineHeight: 20 }}>
                        {insightText}
                      </Text>
                    </View>
                  </View>

                  {/* Study gap card */}
                  <View style={{
                    marginHorizontal: 16,
                    padding: 14, borderRadius: 14,
                    backgroundColor: colors.secondary,
                    borderWidth: 1, borderColor: colors.cardBorder,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#D97706' }} />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706', letterSpacing: 0.4 }}>
                        STUDY GAP DETECTED
                      </Text>
                    </View>
                    <Text style={{ fontSize: 14, color: colors.textPrimary, lineHeight: 20, marginBottom: 12 }}>
                      ECON 121 midterm is Friday and worth 30% of your grade. You need roughly 6 hours of prep — only 2 are currently blocked. Aria found two open windows:
                    </Text>
                    <View style={{ gap: 6, marginBottom: 12 }}>
                      {[
                        { day: 'Wed Apr 2', time: '6:00 – 8:00 PM' },
                        { day: 'Thu Apr 3', time: '9:00 – 11:00 AM' },
                      ].map((slot) => (
                        <View key={slot.day} style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingHorizontal: 12, paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: `${accent}10`,
                          borderWidth: 1, borderColor: `${accent}25`,
                          gap: 10,
                        }}>
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent }} />
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary, flex: 1 }}>
                            {slot.day}
                          </Text>
                          <Text style={{ fontSize: 13, color: colors.textSecondary }}>{slot.time}</Text>
                          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: `${accent}15` }}>
                            <Text style={{ fontSize: 11, fontWeight: '600', color: accent }}>Free</Text>
                          </View>
                        </View>
                      ))}
                    </View>
                    <TouchableOpacity style={{
                      backgroundColor: accent, borderRadius: 10,
                      paddingVertical: 10, alignItems: 'center',
                    }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: '#FFFFFF' }}>Block Both Windows</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              }
            />
          )}

          {/* ── To-Do ── */}
          {activeTab === 'todos' && (
            <View style={{ flex: 1 }}>
              <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 96 }}>
                {todos.map((todo) => (
                  <TouchableOpacity
                    key={todo.id}
                    onPress={() => toggleTodo(todo.id)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 12,
                      padding: 14, borderRadius: 12,
                      backgroundColor: colors.secondary,
                      borderWidth: 1, borderColor: colors.cardBorder,
                    }}
                  >
                    <Ionicons
                      name={todo.done ? 'checkmark-circle' : 'ellipse-outline'}
                      size={24}
                      color={todo.done ? accent : colors.textSecondary}
                    />
                    <Text style={{
                      flex: 1, fontSize: 15,
                      color: todo.done ? colors.textSecondary : colors.textPrimary,
                      textDecorationLine: todo.done ? 'line-through' : 'none',
                    }}>
                      {todo.text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              {/* Floating add button */}
              <TouchableOpacity
                onPress={() => setShowAddTodo(true)}
                style={{
                  position: 'absolute', bottom: 16, right: 16,
                  width: 52, height: 52, borderRadius: 26,
                  backgroundColor: accent,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: accent, shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
                }}
              >
                <Ionicons name="add" size={28} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          )}

          {/* ── Calendar ── */}
          {activeTab === 'calendar' && (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
              {MOCK_CALENDAR.map((event) => {
                const barColor = EVENT_COLORS[event.type] ?? accent
                return (
                  <View key={event.id} style={{
                    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
                    padding: 14, borderRadius: 12,
                    backgroundColor: colors.secondary,
                    borderWidth: 1, borderColor: colors.cardBorder,
                  }}>
                    <View style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: barColor }} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textPrimary, flex: 1 }}>
                          {event.title}
                        </Text>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: `${barColor}18` }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: barColor, textTransform: 'capitalize' }}>
                            {event.type}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 3 }}>{event.time}</Text>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>{event.location}</Text>
                    </View>
                  </View>
                )
              })}
            </ScrollView>
          )}

          {/* ── SMS ── */}
          {activeTab === 'sms' && (
            <View style={{ flex: 1 }}>
              {/* Header */}
              <View style={{
                padding: 16, alignItems: 'center',
                borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
              }}>
                <View style={{
                  width: 44, height: 44, borderRadius: 22,
                  backgroundColor: accent, alignItems: 'center', justifyContent: 'center',
                  marginBottom: 6,
                }}>
                  <Text style={{ fontSize: 20 }}>✦</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textPrimary }}>Aria</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>via SMS · Today</Text>
              </View>

              <FlatList
                data={MOCK_SMS}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: 16, gap: 8 }}
                renderItem={({ item }) => {
                  const isUser = item.from === 'user'
                  return (
                    <View style={{
                      alignSelf: isUser ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                      marginVertical: 2,
                    }}>
                      <View style={{
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 18,
                        borderBottomRightRadius: isUser ? 4 : 18,
                        borderBottomLeftRadius: isUser ? 18 : 4,
                        backgroundColor: isUser ? accent : colors.secondary,
                        borderWidth: isUser ? 0 : 1,
                        borderColor: colors.cardBorder,
                      }}>
                        <Text style={{
                          fontSize: 15,
                          color: isUser ? '#FFFFFF' : colors.textPrimary,
                          lineHeight: 21,
                        }}>
                          {item.text}
                        </Text>
                      </View>
                      <Text style={{
                        fontSize: 11,
                        color: colors.textSecondary,
                        marginTop: 3,
                        alignSelf: isUser ? 'flex-end' : 'flex-start',
                        marginHorizontal: 4,
                      }}>
                        {item.time}
                      </Text>
                    </View>
                  )
                }}
              />
            </View>
          )}

        </View>

        <ChatBar />
      </SafeAreaView>

      {/* Personality sheet */}
      <PersonalitySheet
        visible={showPersonality}
        onClose={() => setShowPersonality(false)}
        personality={personality}
        onChange={setPersonality}
      />

      {/* Notifications modal */}
      <Modal visible={showNotifications} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: '700', color: colors.textPrimary }}>Notifications</Text>
            <TouchableOpacity onPress={() => setShowNotifications(false)}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            {MOCK_NOTIFICATIONS.map((n) => (
              <View key={n.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 12, backgroundColor: colors.secondary, borderWidth: 1, borderColor: colors.cardBorder }}>
                <Ionicons name={n.icon} size={20} color={accent} style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, color: colors.textPrimary, lineHeight: 20 }}>{n.text}</Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>{n.time}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Quick Add To-Do modal */}
      <Modal visible={showAddTodo} animationType="slide" presentationStyle="formSheet" transparent>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View style={{
            backgroundColor: colors.dominant,
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: 20,
            borderWidth: 1, borderColor: colors.cardBorder,
            shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.08, shadowRadius: 12,
          }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 14 }}>
              New To-Do
            </Text>
            <TextInput
              autoFocus
              value={newTodoText}
              onChangeText={setNewTodoText}
              placeholder="What do you need to do?"
              placeholderTextColor={colors.textSecondary}
              returnKeyType="done"
              onSubmitEditing={addTodo}
              style={{
                fontSize: 16,
                color: colors.textPrimary,
                backgroundColor: colors.secondary,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                marginBottom: 12,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => { setShowAddTodo(false); setNewTodoText('') }}
                style={{ flex: 1, padding: 14, borderRadius: 12, backgroundColor: colors.secondary, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={addTodo}
                style={{ flex: 1, padding: 14, borderRadius: 12, backgroundColor: accent, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#FFFFFF' }}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}
