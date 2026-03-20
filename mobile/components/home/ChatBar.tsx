import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import BottomSheet, { BottomSheetBackdrop, BottomSheetModal } from '@gorhom/bottom-sheet'
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import { ChatSheet } from '@/components/chat/ChatSheet'
import { VoiceButton } from '@/components/chat/VoiceButton'
import type { ChatMessage } from '@/types'

/**
 * ChatBar — Zone 4 persistent bottom bar.
 *
 * Fixed at bottom, 64px tall + safe area bottom inset.
 * Shows last Aria message preview (or placeholder if no messages).
 * Tapping anywhere on the bar opens the full-screen BottomSheetModal chat.
 * Right side has a VoiceButton — tapping it also opens the sheet.
 *
 * BottomSheetModal snap points: ['100%'] for full-screen.
 */
export function ChatBar() {
  const { colors, accent } = useTheme()
  const insets = useSafeAreaInsets()
  const sheetRef = useRef<BottomSheetModal>(null)
  const [lastMessage, setLastMessage] = useState<string | null>(null)

  useEffect(() => {
    const loadLastMessage = async () => {
      try {
        const msgs: ChatMessage[] = await api.getChatMessages(1)
        if (msgs.length > 0) {
          setLastMessage(msgs[0].body)
        }
      } catch {
        // Non-blocking — show placeholder
      }
    }
    loadLastMessage()
  }, [])

  const openSheet = useCallback(() => {
    sheetRef.current?.present()
  }, [])

  const handleVoiceResult = useCallback((text: string) => {
    // Open chat and pass voice text — ChatSheet will handle sending
    openSheet()
  }, [openSheet])

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={0.5}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [],
  )

  return (
    <>
      <TouchableOpacity
        onPress={openSheet}
        activeOpacity={0.85}
        style={{
          height: 64 + insets.bottom,
          backgroundColor: colors.secondary,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingBottom: insets.bottom,
          borderTopWidth: 1,
          borderTopColor: colors.cardBorder,
        }}
        accessibilityLabel="Open chat"
        accessibilityRole="button"
      >
        <Text
          style={{
            flex: 1,
            fontSize: 14,
            color: colors.textSecondary,
          }}
          numberOfLines={1}
        >
          {lastMessage ?? 'Ask Aria anything…'}
        </Text>
        <VoiceButton onResult={handleVoiceResult} />
      </TouchableOpacity>

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={['100%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: colors.dominant }}
        handleIndicatorStyle={{ backgroundColor: colors.textSecondary }}
      >
        <ChatSheet />
      </BottomSheetModal>
    </>
  )
}
