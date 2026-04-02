import React from 'react'
import { View, Text, Animated } from 'react-native'
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist'
import { DeadlineCard } from './DeadlineCard'
import { PlaceholderCard } from './PlaceholderCard'
import { useTheme } from '@/lib/theme'
import type { Task } from '@/types'

type CardGridProps = {
  tasks: Task[]
  onDone: (id: string) => void
  onSnooze: (id: string) => void
  onHide: (id: string) => void
  onReorder: (data: Task[]) => void
  loading: boolean
  ListHeaderComponent?: React.ReactElement
}

/** Skeleton shimmer animation for a single card placeholder */
function SkeletonCard() {
  const { colors } = useTheme()
  const shimmer = React.useRef(new Animated.Value(0)).current

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 800, useNativeDriver: false }),
        Animated.timing(shimmer, { toValue: 0, duration: 800, useNativeDriver: false }),
      ])
    ).start()
  }, [shimmer])

  const bgColor = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.secondary, colors.cardBorder],
  })

  return (
    <Animated.View
      style={{
        height: 72,
        borderRadius: 12,
        backgroundColor: bgColor,
      }}
    />
  )
}

/**
 * Zone 3 — CardGrid
 * DraggableFlatList wrapper that renders DeadlineCards with drag-to-reorder,
 * skeleton loading state, empty state, and PlaceholderCards for unconnected integrations.
 */
export function CardGrid({ tasks, onDone, onSnooze, onHide, onReorder, loading, ListHeaderComponent }: CardGridProps) {
  const { colors } = useTheme()

  if (loading) {
    return (
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 16, gap: 16 }}>
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </View>
    )
  }

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Task>) => (
    <DeadlineCard
      task={item}
      drag={drag}
      isActive={isActive}
      onDone={onDone}
      onSnooze={onSnooze}
      onHide={onHide}
    />
  )

  const ListEmptyComponent = (
    <View style={{ alignItems: 'center', paddingTop: 48 }}>
      <Text
        style={{
          fontSize: 20,
          fontWeight: '600',
          color: colors.textPrimary,
          marginBottom: 8,
        }}
      >
        No deadlines right now
      </Text>
      <Text
        style={{
          fontSize: 16,
          color: colors.textSecondary,
          textAlign: 'center',
          paddingHorizontal: 24,
        }}
      >
        Canvas syncs every hour. Check back soon or pull to refresh.
      </Text>
    </View>
  )

  const ListFooterComponent = <View />

  return (
    <DraggableFlatList
      data={tasks}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      onDragEnd={({ data }) => onReorder(data)}
      ListHeaderComponent={ListHeaderComponent}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 80,
      }}
      ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
      ListEmptyComponent={ListEmptyComponent}
      ListFooterComponent={ListFooterComponent}
    />
  )
}
