import "server-only";
// OWNER: 1.2

/**
 * Conversation-pipeline and delivery tuning constants (V2-03 §6). Constants, not env: changing one
 * is a code change with a test, not a deploy-time knob.
 */
export const PIPELINE = {
  /** Debounce after the last inbound bubble before a turn runs. */
  debounceMs: 2_500,
  /** Hard cap on how long a burst can push the turn back. */
  maxDebounceMs: 8_000,
  /** Interim bubble ("one sec 👀") fires this long after run start with nothing sent. */
  watchdogMs: 8_000,
  /** Per-user run lease TTL and heartbeat. */
  leaseTtlMs: 60_000,
  heartbeatMs: 20_000,
  /** A run aborts after this (Vercel Hobby cap is 300s). */
  runDeadlineMs: 270_000,
  /** Inbound messages per channel per minute before turns stop being kicked. */
  inboundRatePerMin: 30,
  /** Agent turns per user per local day (cost guard). */
  dailyTurnCap: 200,

  /** Routine proactive deliveries per local day (urgent/requested don't count). */
  proactiveDailyCap: 3,
  /** Minimum gap between two proactive sends (bundling window). */
  bundleWindowMs: 10 * 60_000,
  /** A routine item waits at least this long in the outbox so siblings can join it. */
  routineHoldMs: 30_000,
  /** Distinct outside-window recipients per line per 24h before proactive sends defer (Sendblue cap 200). */
  followupQuota: 180,
  /** Deferral when the follow-up quota is hit. */
  followupQuotaDeferMs: 60 * 60_000,
  /** Deferral while a conversation run holds the lease (never interleave with a live reply). */
  conversationActiveDeferMs: 30_000,
  /** Messaging window: a channel is "in window" if the user texted within this long. */
  windowMs: 24 * 60 * 60_000,
  /** Upper bound of the random jitter added to a quiet-hours deferral. */
  quietJitterMaxMs: 5 * 60_000,
  /** Default quiet hours (users.quiet_start / quiet_end). */
  defaultQuietStart: "22:00",
  defaultQuietEnd: "08:00",
  /** Minimum quiet window on SMS/RCS (spec §3.22: proactive only 8am–9pm). */
  smsQuietStart: "21:00",
  smsQuietEnd: "08:00",

  /** Reply-plan caps (bubbles include the link bubble and any interim already sent). */
  maxBubbles: 3,
  maxBubbleChars: 1_200,
  maxReactions: 2,

  /** Pacing: typing pause ∝ length, clamped. */
  charsPerSecond: 35,
  minPauseMs: 800,
  maxPauseMs: 4_000,

  /** Default `pause` command duration. */
  defaultPauseMs: 24 * 60 * 60_000,
  /** Longest pause the keyword command accepts. */
  maxPauseDays: 30,

  /** Provider HTTP timeout (Sendblue). */
  providerTimeoutMs: 10_000,
} as const;
