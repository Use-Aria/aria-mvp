import React from 'react'
import { View, Text, TouchableOpacity, Animated } from 'react-native'
import { Swipeable } from 'react-native-gesture-handler'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'
import type { Task } from '@/types'

type DeadlineCardProps = {
  task: Task
  onDone: (id: string) => void
  onSnooze: (id: string) => void
  onHide: (id: string) => void
  isActive?: boolean
  drag?: () => void
}

/**
 * Expandable deadline card with swipe-to-hide and long-press drag support.
 *
 * States:
 * - Collapsed (default): 72px, shows title + due date + course
 * - Expanded: border accent highlight, full details + Done/Snooze/More action buttons
 * - Active (drag): shadow + 1.03 scale transform
 *
 * NOTE: onDone and onSnooze are UI-only in Phase 8.
 * No backend routes exist yet for marking tasks complete or snoozing.
 */
function priorityColor(due_date: string): string {
  const diff = new Date(due_date).getTime() - Date.now()
  const days = diff / (1000 * 60 * 60 * 24)
  if (days < 1) return '#DC2626'   // red — due today
  if (days < 3) return '#D97706'   // amber — due within 3 days
  return '#16A34A'                  // green — 4+ days away
}

export function DeadlineCard({ task, onDone, onSnooze, onHide, isActive, drag }: DeadlineCardProps) {
  const { colors, accent } = useTheme()
  const [expanded, setExpanded] = React.useState(false)
  const dotColor = priorityColor(task.due_date)

  const formattedDate = React.useMemo(() => {
    try {
      return new Date(task.due_date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    } catch {
      return task.due_date
    }
  }, [task.due_date])

  const shortDate = React.useMemo(() => {
    try {
      return new Date(task.due_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return task.due_date
    }
  }, [task.due_date])

  /** Right swipe action — reveals red "Hide" button */
  const renderRightActions = () => (
    <TouchableOpacity
      onPress={() => onHide(task.id)}
      style={{
        width: 80,
        backgroundColor: '#FF3B30',
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 12,
        marginLeft: 8,
      }}
    >
      <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>Hide</Text>
    </TouchableOpacity>
  )

  return (
    <Swipeable renderRightActions={renderRightActions} overshootRight={false}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        onLongPress={drag}
        delayLongPress={200}
        activeOpacity={0.95}
        style={[
          {
            borderRadius: 12,
            padding: 16,
            backgroundColor: colors.dominant,
            borderWidth: expanded ? 2 : 1,
            borderColor: expanded ? accent : colors.cardBorder,
            minHeight: 72,
          },
          isActive && {
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.15,
            shadowRadius: 8,
            transform: [{ scale: 1.03 }],
          },
        ]}
      >
        {/* Collapsed row: priority dot + title + short date */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: dotColor,
            marginTop: 5, marginRight: 8, flexShrink: 0,
          }} />
          <Text
            style={{
              fontSize: 16,
              fontWeight: '600',
              color: colors.textPrimary,
              flex: 1,
              marginRight: 8,
            }}
            numberOfLines={expanded ? undefined : 1}
          >
            {task.title}
          </Text>
          {!expanded && (
            <Text style={{ fontSize: 14, color: colors.textSecondary }}>
              {shortDate}
            </Text>
          )}
        </View>

        {/* Course name — always visible */}
        {task.course && (
          <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 2 }}>
            {task.course}
          </Text>
        )}

        {/* Expanded details */}
        {expanded && (
          <>
            <View style={{ marginTop: 8 }}>
              <Text style={{ fontSize: 14, color: colors.textSecondary }}>
                Due: {formattedDate}
              </Text>
              {task.weight !== undefined && (
                <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 2 }}>
                  {task.weight}% of grade
                </Text>
              )}
              {/* NOTE: Urgency score display is deferred to Phase 9 / post-Phase 6 integration.
                  The /api/deadlines endpoint returns Task[] which does not include scored events
                  from canonical_events. No score field is rendered here. */}
            </View>

            {/* Action buttons row */}
            <View
              style={{
                flexDirection: 'row',
                marginTop: 16,
                gap: 8,
              }}
            >
              {/* Done button */}
              <TouchableOpacity
                onPress={() => {
                  // TODO: wire to backend when task completion API is built
                  onDone(task.id)
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 44,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor: `${accent}15`,
                  gap: 4,
                }}
              >
                <Ionicons name="checkmark-circle" size={18} color={accent} />
                <Text style={{ fontSize: 14, color: accent, fontWeight: '600' }}>Done</Text>
              </TouchableOpacity>

              {/* Snooze button */}
              <TouchableOpacity
                onPress={() => {
                  // TODO: wire to backend when snooze API is built
                  onSnooze(task.id)
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 44,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor: `${colors.textSecondary}15`,
                  gap: 4,
                }}
              >
                <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
                <Text style={{ fontSize: 14, color: colors.textSecondary }}>Snooze</Text>
              </TouchableOpacity>

              {/* More button — placeholder for future menu */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 44,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor: `${colors.textSecondary}15`,
                  gap: 4,
                }}
              >
                <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
                <Text style={{ fontSize: 14, color: colors.textSecondary }}>More</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </TouchableOpacity>
    </Swipeable>
  )
}
