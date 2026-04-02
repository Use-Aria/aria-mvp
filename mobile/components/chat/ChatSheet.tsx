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
import { MOCK_CHAT_MESSAGES } from '@/lib/mockData'
import type { ChatMessage } from '@/types'

const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === 'true'
import { MessageBubble } from './MessageBubble'
import { VoiceButton } from './VoiceButton'

const SUGGESTIONS = [
  "What's due this week?",
  "Block study time for ECON",
  "Any emails from professors?",
  "How's my week looking?",
]

function SuggestionChips({ onSelect }: { onSelect: (text: string) => void }) {
  const { colors, accent } = useTheme()
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}>
      <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 8, fontWeight: '600', letterSpacing: 0.3 }}>
        SUGGESTED
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {SUGGESTIONS.map((s) => (
          <TouchableOpacity
            key={s}
            onPress={() => onSelect(s)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8,
              borderRadius: 18,
              backgroundColor: `${accent}12`,
              borderWidth: 1, borderColor: `${accent}30`,
            }}
          >
            <Text style={{ fontSize: 14, color: accent, fontWeight: '500' }}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  )
}

/**
 * ChatSheet — full-screen in-app chat view.
 *
 * Rendered inside a BottomSheetModal by ChatBar.
 * Fetches chat history from /api/chat on open.
 * Sends messages via api.sendChatMessage with optimistic updates.
 * Supports voice input via VoiceButton — transcribed text auto-sends.
 * Chat history is independent from SMS (source: 'app').
 */
export function ChatSheet({ onClose }: { onClose?: () => void }) {
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
      if (DEMO_MODE) {
        setMessages(MOCK_CHAT_MESSAGES)
        setHasMore(false)
        setLoading(false)
        return
      }
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

    if (DEMO_MODE) {
      // Simulate Aria reply after a short delay
      setTimeout(() => {
        const ariaReply: ChatMessage = {
          id: `demo-reply-${Date.now()}`,
          user_id: 'demo-user',
          direction: 'in',
          body: "Got it! I'll take care of that for you.",
          sent_at: new Date().toISOString(),
          source: 'app',
        }
        setMessages((prev) => [ariaReply, ...prev])
        setSending(false)
      }, 800)
      return
    }

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
      {/* Header */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
      }}>
        <View style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: accent, alignItems: 'center', justifyContent: 'center',
          marginRight: 10,
        }}>
          <Text style={{ fontSize: 16, color: '#fff' }}>A</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.textPrimary }}>Aria</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary }}>AI assistant</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {/* Message list — inverted so newest messages appear at the bottom */}
      {messages.length === 0 ? (
        <View style={{ flex: 1, padding: 24, justifyContent: 'flex-end', paddingBottom: 16 }}>
          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 }}>
              Hi Seb, I'm Aria
            </Text>
            <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: 'center' }}>
              Ask me anything about your week, deadlines, or schedule.
            </Text>
          </View>
          <SuggestionChips onSelect={(text) => sendMessage(text)} />
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
          ListFooterComponent={
            <SuggestionChips onSelect={(text) => sendMessage(text)} />
          }
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
