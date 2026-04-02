import React, { useState } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { useTheme } from '@/lib/theme'

// ── Types ──────────────────────────────────────────────────────────────────────

type RingKey = 'academic' | 'commitments' | 'capacity'

type RingProps = {
  id: RingKey
  percent: number
  color: string
  size?: number
  stroke?: number
  label: string
  value: string
  active: boolean
  onPress: (id: RingKey) => void
}

type DetailRow = { label: string; value: string; bar?: number; color?: string; tag?: string }

export type StatsRingsProps = {
  academicPercent: number
  commitmentsPercent: number
  capacityPercent: number
}

// ── Ring ───────────────────────────────────────────────────────────────────────

function Ring({ id, percent, color, size = 88, stroke = 9, label, value, active, onPress }: RingProps) {
  const { colors } = useTheme()
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const filled = circ * (Math.min(percent, 100) / 100)
  const gap = circ - filled

  return (
    <TouchableOpacity onPress={() => onPress(id)} activeOpacity={0.75} style={{ alignItems: 'center', gap: 6 }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size} style={{ position: 'absolute' }}>
          <Circle
            cx={size / 2} cy={size / 2} r={r}
            stroke={active ? `${color}40` : colors.cardBorder}
            strokeWidth={stroke} fill="none"
          />
          <Circle
            cx={size / 2} cy={size / 2} r={r}
            stroke={color} strokeWidth={active ? stroke + 1 : stroke}
            fill="none"
            strokeDasharray={`${filled} ${gap}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
        <Text style={{ fontSize: 17, fontWeight: '700', color: active ? color : colors.textPrimary }}>
          {value}
        </Text>
      </View>
      <Text style={{
        fontSize: 11, fontWeight: '600', letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: active ? color : colors.textSecondary,
      }}>
        {label}
      </Text>
    </TouchableOpacity>
  )
}

// ── Detail row ─────────────────────────────────────────────────────────────────

function DetailRowItem({ label, value, bar, color, tag }: DetailRow) {
  const { colors } = useTheme()
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: bar !== undefined ? 4 : 0 }}>
        <Text style={{ fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 }} numberOfLines={1}>
          {label}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {tag && (
            <View style={{
              paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5,
              backgroundColor: `${color}18`,
            }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {tag}
              </Text>
            </View>
          )}
          <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '600' }}>{value}</Text>
        </View>
      </View>
      {bar !== undefined && color && (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.cardBorder }}>
          <View style={{
            height: 4, borderRadius: 2, backgroundColor: color,
            width: `${Math.min(bar, 100)}%`,
          }} />
        </View>
      )}
    </View>
  )
}

// ── Detail panels ──────────────────────────────────────────────────────────────

function AcademicDetail() {
  const { colors } = useTheme()
  const color = '#D97706'
  return (
    <View>
      <Text style={{ fontSize: 12, fontWeight: '700', color, letterSpacing: 0.4, marginBottom: 12 }}>
        UPCOMING DEADLINES
      </Text>
      <DetailRowItem label="HIST 115 — Response Paper" value="Tomorrow" bar={95} color={color} tag="urgent" />
      <DetailRowItem label="CPSC 323 — Problem Set 5" value="Thu Apr 3" bar={75} color={color} />
      <DetailRowItem label="ECON 121 — Midterm" value="Fri Apr 4" bar={65} color={color} tag="30%" />
      <DetailRowItem label="MATH 230 — Problem Set 8" value="Tue Apr 7" bar={35} color={color} />
      <DetailRowItem label="CPSC 200 — Lab Report" value="Thu Apr 9" bar={20} color={color} />
      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
        Bars reflect urgency based on due date and grade weight.
      </Text>
    </View>
  )
}

function CommitmentsDetail() {
  const { colors } = useTheme()
  const color = '#5856D6'

  return (
    <View>
      {/* Calendar section */}
      <Text style={{ fontSize: 12, fontWeight: '700', color, letterSpacing: 0.4, marginBottom: 10 }}>
        FROM CALENDAR
      </Text>
      <DetailRowItem label="Gym" value="Done · 7:30 AM" bar={100} color={color} tag="done" />
      <DetailRowItem label="Yale Debate Society" value="Today · 6:00 PM" bar={60} color={color} />
      <DetailRowItem label="Goldman Sachs — Recruiter Call" value="Thu · 3:00 PM" bar={40} color={color} />

      <View style={{ height: 1, backgroundColor: colors.cardBorder, marginVertical: 12 }} />

      {/* To-do section */}
      <Text style={{ fontSize: 12, fontWeight: '700', color, letterSpacing: 0.4, marginBottom: 10 }}>
        PERSONAL TO-DO
      </Text>
      <DetailRowItem label="Submit spring housing application" value="Due Apr 5" bar={0} color={color} tag="pending" />
      <DetailRowItem label="Call financial aid office" value="This week" bar={0} color={color} tag="pending" />

      <View style={{ height: 1, backgroundColor: colors.cardBorder, marginVertical: 12 }} />

      {/* Gmail section */}
      <Text style={{ fontSize: 12, fontWeight: '700', color, letterSpacing: 0.4, marginBottom: 10 }}>
        FROM GMAIL
      </Text>
      <DetailRowItem
        label="Goldman — confirm interview availability"
        value="Reply by Fri"
        bar={0} color={color} tag="action"
      />
      <DetailRowItem
        label="Housing Office — selection closes Apr 5"
        value="3 days"
        bar={30} color={color} tag="action"
      />

      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
        Aria extracted these action items from your inbox.
      </Text>
    </View>
  )
}

function CapacityDetail() {
  const { colors } = useTheme()
  const color = '#16A34A'
  return (
    <View>
      <Text style={{ fontSize: 12, fontWeight: '700', color, letterSpacing: 0.4, marginBottom: 12 }}>
        FREE BLOCKS THIS WEEK
      </Text>
      <DetailRowItem label="Today · 4:00 – 6:00 PM" value="2 hrs" bar={25} color={color} tag="open" />
      <DetailRowItem label="Wed Apr 2 · 6:00 – 8:00 PM" value="2 hrs" bar={25} color={color} tag="open" />
      <DetailRowItem label="Thu Apr 3 · 9:00 – 11:00 AM" value="2 hrs" bar={25} color={color} tag="open" />
      <DetailRowItem label="Sat Apr 5 · All day" value="8+ hrs" bar={100} color={color} tag="open" />

      <View style={{
        marginTop: 8, paddingTop: 10,
        borderTopWidth: 1, borderTopColor: colors.cardBorder,
        flexDirection: 'row', justifyContent: 'space-between',
      }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>Total free this week</Text>
        <Text style={{ fontSize: 13, fontWeight: '700', color }}>~14 hrs</Text>
      </View>
      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 8 }}>
        Higher capacity means more breathing room. Aria uses open blocks to schedule study time.
      </Text>
    </View>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function StatsRings({ academicPercent, commitmentsPercent, capacityPercent }: StatsRingsProps) {
  const { colors } = useTheme()
  const [activeRing, setActiveRing] = useState<RingKey | null>(null)

  const handlePress = (id: RingKey) =>
    setActiveRing((prev) => (prev === id ? null : id))

  const RING_COLORS: Record<RingKey, string> = {
    academic: '#D97706',
    commitments: '#5856D6',
    capacity: '#16A34A',
  }

  return (
    <View style={{ backgroundColor: colors.dominant, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>

      {/* Section label */}
      <Text style={{
        fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
        color: colors.textSecondary, textTransform: 'uppercase',
        textAlign: 'center', paddingTop: 14, marginBottom: 2,
      }}>
        Today's Overview
      </Text>

      {/* Rings row */}
      <View style={{
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
      }}>
        <Ring
          id="academic" percent={academicPercent} color={RING_COLORS.academic}
          label="Academic" value={`${Math.round(academicPercent)}%`}
          active={activeRing === 'academic'} onPress={handlePress}
        />
        <Ring
          id="commitments" percent={commitmentsPercent} color={RING_COLORS.commitments}
          label="Commitments" value={`${Math.round(commitmentsPercent)}%`}
          active={activeRing === 'commitments'} onPress={handlePress}
        />
        <Ring
          id="capacity" percent={capacityPercent} color={RING_COLORS.capacity}
          label="Capacity" value={`${Math.round(capacityPercent)}%`}
          active={activeRing === 'capacity'} onPress={handlePress}
        />
      </View>

      {/* Expanded detail panel */}
      {activeRing && (
        <View style={{
          marginHorizontal: 16, marginBottom: 16,
          padding: 14, borderRadius: 12,
          backgroundColor: `${RING_COLORS[activeRing]}08`,
          borderWidth: 1, borderColor: `${RING_COLORS[activeRing]}25`,
        }}>
          {activeRing === 'academic' && <AcademicDetail />}
          {activeRing === 'commitments' && <CommitmentsDetail />}
          {activeRing === 'capacity' && <CapacityDetail />}
          <TouchableOpacity onPress={() => setActiveRing(null)} style={{ alignItems: 'center', marginTop: 12 }}>
            <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '600' }}>Collapse</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}
