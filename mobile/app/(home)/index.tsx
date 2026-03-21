import { SafeAreaView } from 'react-native-safe-area-context'
import { QuickAccessBar } from '@/components/home/QuickAccessBar'
import { LoadStatusBar } from '@/components/home/LoadStatusBar'
import { CardGrid } from '@/components/home/CardGrid'
import { ChatBar } from '@/components/home/ChatBar'
import { useCards } from '@/hooks/useCards'
import { useTheme } from '@/lib/theme'

export default function Home() {
  const { tasks, loading, loadLevel, hideCard, reorderCards } = useCards()
  const { colors } = useTheme()

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.dominant }}>
      {/* Zone 1: Quick-access icon bar (To-Do, Calendar, Notifications) */}
      <QuickAccessBar />

      {/* Zone 2: Color-coded load status bar — primary focal point */}
      <LoadStatusBar
        level={loadLevel}
        deadlineCount={tasks.filter((t) => t.status === 'upcoming').length}
      />

      {/* Zone 3: Scrollable, draggable card grid */}
      <CardGrid
        tasks={tasks}
        loading={loading}
        onDone={(id) => {
          // TODO: wire to backend when task completion API is built
        }}
        onSnooze={(id) => {
          // TODO: wire to backend when snooze API is built
        }}
        onHide={hideCard}
        onReorder={reorderCards}
      />

      {/* Zone 4: ChatBar — persistent bottom bar that opens full-screen chat sheet */}
      <ChatBar />
    </SafeAreaView>
  )
}
