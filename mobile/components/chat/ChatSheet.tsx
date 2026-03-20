import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import type { ChatMessage } from '@/types'
import { MessageBubble } from './MessageBubble'
import { VoiceButton } from './VoiceButton'

/**
 * ChatSheet — full-screen in-app chat view.
 *
 * Rendered inside a BottomSheetModal by ChatBar.
 * Fetches chat history from /api/chat on open.
 * Sends messages via api.sendChatMessage with optimistic updates.
 * Supports voice input via VoiceButton — transcribed text auto-sends.
 * Chat history is independent from SMS (source: 'app').
 */
export function ChatSheet() {
  const { accent, colors } = useTheme()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const loadingMore = useRef(false)

  /** Load initial messages on mount */
  useEffect(() => {
    const loadMessages = async () => {
      setLoading(true)
      try {
        const data = await api.getChatMessages(20)
        setMessages(data)
        setHasMore(data.length === 20)
      } catch {
        // Non-blocking — show empty state
      } finally {
        setLoading(false)
      }
    }
    loadMessages()
  }, [])

  /** Load older messages when user scrolls to the top (inverted list: scroll to end) */
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore.current || messages.length === 0) return
    loadingMore.current = true
    try {
      const oldest = messages[messages.length - 1]
      const data = await api.getChatMessages(20, oldest.sent_at)
      if (data.length === 0) {
        setHasMore(false)
      } else {
        setMessages((prev) => [...prev, ...data])
        setHasMore(data.length === 20)
      }
    } catch {
      // Non-blocking
    } finally {
      loadingMore.current = false
    }
  }, [hasMore, messages])

  /**
   * Send a message — optimistic update then API call.
   * On error: marks the optimistic message with an error indicator via a status field.
   */
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending) return

    setInputText('')
    setSending(true)

    // Optimistic user message
    const optimisticMsg: ChatMessage & { error?: boolean } = {
      id: `optimistic-${Date.now()}`,
      user_id: '',
      direction: 'out',
      body: trimmed,
      sent_at: new Date().toISOString(),
      source: 'app',
    }
    setMessages((prev) => [optimisticMsg, ...prev])

    try {
      const sentMsg = await api.sendChatMessage(trimmed)
      // Replace the optimistic message with the real one and add Aria's reply
      setMessages((prev) => {
        const withoutOptimistic = prev.filter((m) => m.id !== optimisticMsg.id)
        return [sentMsg, ...withoutOptimistic]
      })
    } catch {
      // Mark optimistic message with error
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticMsg.id ? { ...m, error: true } : m,
        ),
      )
    } finally {
      setSending(false)
    }
  }, [sending])

  /** Voice result auto-sends through the same pipeline */
  const handleVoiceResult = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={accent} />
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.dominant }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Message list — inverted so newest messages appear at the bottom */}
      {messages.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text
            style={{
              fontSize: 20,
              fontWeight: '600',
              color: colors.textPrimary,
              textAlign: 'center',
            }}
          >
            No messages yet
          </Text>
          <Text
            style={{
              fontSize: 16,
              color: colors.textSecondary,
              textAlign: 'center',
              marginTop: 8,
            }}
          >
            Say hi or ask about your week.
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          inverted
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          contentContainerStyle={{ paddingVertical: 8 }}
          style={{ flex: 1 }}
        />
      )}

      {/* Input bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 8,
          borderTopWidth: 1,
          borderTopColor: colors.cardBorder,
          backgroundColor: colors.dominant,
          gap: 8,
        }}
      >
        <TextInput
          style={{
            flex: 1,
            height: 44,
            borderRadius: 22,
            paddingHorizontal: 16,
            backgroundColor: colors.secondary,
            fontSize: 16,
            color: colors.textPrimary,
          }}
          placeholder="Ask Aria anything..."
          placeholderTextColor={colors.textSecondary}
          value={inputText}
          onChangeText={setInputText}
          onSubmitEditing={() => sendMessage(inputText)}
          returnKeyType="send"
          multiline={false}
        />
        <TouchableOpacity
          onPress={() => sendMessage(inputText)}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          disabled={sending || !inputText.trim()}
          accessibilityLabel="Send message"
        >
          <Ionicons
            name="send"
            size={22}
            color={inputText.trim() ? accent : colors.textSecondary}
          />
        </TouchableOpacity>
        <VoiceButton onResult={handleVoiceResult} />
      </View>
    </KeyboardAvoidingView>
  )
}
