import React, { useState, useMemo } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  FlatList,
  SafeAreaView,
  Platform,
  StatusBar,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'
import { UNIVERSITIES } from '@/lib/universities'

interface Props {
  value: string
  onChange: (university: string) => void
  testID?: string
}

/**
 * University selector for the profile screen.
 * Renders like a text input; tapping opens a full-screen modal with
 * a search bar and a scrollable list of Canvas-confirmed universities.
 */
export default function UniversityPicker({ value, onChange, testID }: Props) {
  const { accent, colors } = useTheme()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return UNIVERSITIES
    return UNIVERSITIES.filter((u) => u.name.toLowerCase().includes(q))
  }, [query])

  const handleSelect = (name: string) => {
    onChange(name)
    setOpen(false)
    setQuery('')
  }

  const handleClear = () => {
    onChange('')
    setQuery('')
  }

  return (
    <>
      {/* Trigger — looks identical to the other inputs */}
      <TouchableOpacity
        testID={testID}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
        style={{
          height: 56,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderColor: colors.cardBorder,
          backgroundColor: colors.dominant,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontSize: 16,
            color: value ? colors.textPrimary : colors.textSecondary,
          }}
        >
          {value || 'Select your university'}
        </Text>
        {value ? (
          <TouchableOpacity
            onPress={handleClear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID="university-clear-btn"
          >
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
        )}
      </TouchableOpacity>

      {/* Full-screen modal */}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => { setOpen(false); setQuery('') }}
      >
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: colors.dominant,
            paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: colors.cardBorder,
            }}
          >
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.textPrimary }}>
              Select University
            </Text>
            <TouchableOpacity
              onPress={() => { setOpen(false); setQuery('') }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={{ fontSize: 16, color: accent }}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colors.secondary,
                borderRadius: 10,
                paddingHorizontal: 12,
                height: 40,
                gap: 8,
              }}
            >
              <Ionicons name="search" size={16} color={colors.textSecondary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                placeholderTextColor={colors.textSecondary}
                autoFocus
                returnKeyType="search"
                style={{ flex: 1, fontSize: 16, color: colors.textPrimary }}
                testID="university-search-input"
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => setQuery('')}>
                  <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* List */}
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.name}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => handleSelect(item.name)}
                style={{
                  paddingHorizontal: 20,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.cardBorder,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text style={{ fontSize: 16, color: colors.textPrimary, flex: 1 }}>
                  {item.name}
                </Text>
                {item.name === value && (
                  <Ionicons name="checkmark" size={18} color={accent} />
                )}
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={{ textAlign: 'center', color: colors.textSecondary, marginTop: 32, fontSize: 15 }}>
                No results for "{query}"
              </Text>
            }
          />
        </SafeAreaView>
      </Modal>
    </>
  )
}
