import React from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/lib/theme'
import type { ChatMessage } from '@/types'

type MessageBubbleProps = {
  message: ChatMessage
}

/**
 * MessageBubble — renders a single chat message.
 *
 * User messages (direction='out'): right-aligned, accent background, white text,
 * borderRadius 16 with topRight 4 for chat bubble shape.
 *
 * Aria messages (direction='in'): left-aligned, secondary background, textPrimary color,
 * borderRadius 16 with topLeft 4.
 *
 * Max width 80% of container. Timestamp shown below bubble, aligned to bubble side.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const { accent, colors } = useTheme()
  const isUser = message.direction === 'out'

  const timestamp = new Date(message.sent_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <View
      style={{
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginVertical: 4,
        paddingHorizontal: 16,
      }}
    >
      <View
        style={{
          maxWidth: '80%',
          backgroundColor: isUser ? accent : colors.secondary,
          borderRadius: 16,
          borderTopRightRadius: isUser ? 4 : 16,
          borderTopLeftRadius: isUser ? 16 : 4,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Text
          style={{
            fontSize: 16,
            color: isUser ? '#FFFFFF' : colors.textPrimary,
          }}
        >
          {message.body}
        </Text>
      </View>
      <Text
        style={{
          fontSize: 12,
          color: colors.textSecondary,
          marginTop: 2,
          marginHorizontal: 4,
        }}
      >
        {timestamp}
      </Text>
    </View>
  )
}
