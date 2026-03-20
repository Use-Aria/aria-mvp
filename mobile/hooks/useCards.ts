import { useState, useEffect, useCallback } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { api } from '@/lib/api'
import type { Task } from '@/types'

const HIDDEN_CARDS_KEY = '@aria_hidden_cards'
const CARD_ORDER_KEY = '@aria_card_order'

type LoadLevel = 'light' | 'busy' | 'heavy'

type UseCardsReturn = {
  tasks: Task[]
  loading: boolean
  error: string | null
  refresh: () => void
  hideCard: (id: string) => void
  reorderCards: (data: Task[]) => void
  loadLevel: LoadLevel
}

/**
 * Hook that fetches and manages deadline cards for the home screen.
 *
 * - Fetches deadlines from /api/deadlines via api.getDeadlines()
 * - Computes loadLevel from upcoming tasks due within 7 days (0–3=light, 4–6=busy, 7+=heavy)
 * - Persists hidden card IDs in AsyncStorage under '@aria_hidden_cards'
 * - Persists card order in AsyncStorage under '@aria_card_order'
 * - Filters out hidden tasks and restores saved card order on load
 */
export function useCards(): UseCardsReturn {
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /** Load persisted hidden IDs and card order from AsyncStorage */
  const loadPersistedState = useCallback(async () => {
    try {
      const [hiddenRaw, orderRaw] = await Promise.all([
        AsyncStorage.getItem(HIDDEN_CARDS_KEY),
        AsyncStorage.getItem(CARD_ORDER_KEY),
      ])
      if (hiddenRaw) {
        const ids: string[] = JSON.parse(hiddenRaw)
        setHiddenIds(new Set(ids))
      }
      if (orderRaw) {
        const ids: string[] = JSON.parse(orderRaw)
        setOrderedIds(ids)
      }
    } catch {
      // Persisted state failure is non-blocking — continue with defaults
    }
  }, [])

  const fetchTasks = useCallback(async () => {
    try {
      setError(null)
      const data = await api.getDeadlines()
      setAllTasks(data)
    } catch {
      setError('Something went wrong. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await loadPersistedState()
      await fetchTasks()
    }
    init()
  }, [loadPersistedState, fetchTasks])

  const refresh = useCallback(() => {
    setLoading(true)
    fetchTasks()
  }, [fetchTasks])

  const hideCard = useCallback(async (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      const ids = Array.from(next)
      AsyncStorage.setItem(HIDDEN_CARDS_KEY, JSON.stringify(ids)).catch(() => {})
      return next
    })
  }, [])

  const reorderCards = useCallback(async (data: Task[]) => {
    const ids = data.map((t) => t.id)
    setOrderedIds(ids)
    setAllTasks(data)
    AsyncStorage.setItem(CARD_ORDER_KEY, JSON.stringify(ids)).catch(() => {})
  }, [])

  /** Apply hidden filter and stored order */
  const tasks = (() => {
    const visible = allTasks.filter((t) => !hiddenIds.has(t.id))
    if (orderedIds.length === 0) return visible

    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    return [...visible].sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Infinity
      const bi = orderMap.get(b.id) ?? Infinity
      return ai - bi
    })
  })()

  /** Count upcoming tasks due within the next 7 days to determine load level */
  const loadLevel: LoadLevel = (() => {
    const now = Date.now()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const upcomingSoon = tasks.filter((t) => {
      if (t.status !== 'upcoming') return false
      const due = new Date(t.due_date).getTime()
      return due >= now && due <= now + sevenDays
    })
    if (upcomingSoon.length <= 3) return 'light'
    if (upcomingSoon.length <= 6) return 'busy'
    return 'heavy'
  })()

  return { tasks, loading, error, refresh, hideCard, reorderCards, loadLevel }
}
