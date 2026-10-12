/**
 * Web copy deck (web plan §9) as typed records. Pure and client-safe.
 * Voice: plain, second person, short; errors say what happened and how to fix it.
 * `tests/unit/copy.test.ts` checks that every error/status code has copy and that no
 * string is vague ("error occurred", "invalid input").
 */
import type { ActionErrorCode, CanvasConnectErrorCode } from "@/shared/action-result";

/** Google OAuth callback codes (mirrors `GoogleConnectStatus` in the Google barrel). */
export const GOOGLE_CONNECT_CODES = [
  "connected",
  "missing_scopes",
  "denied",
  "admin_blocked",
  "stale",
  "expired",
  "account_in_use",
  "error",
] as const;
export type GoogleConnectCode = (typeof GOOGLE_CONNECT_CODES)[number];

/**
 * Allow-lists a `?google=` query value.
 * @param value raw query param
 * @returns the code, or null for anything not in the fixed set (never echo query text)
 */
export function parseGoogleConnectCode(value: unknown): GoogleConnectCode | null {
  return typeof value === "string" && (GOOGLE_CONNECT_CODES as readonly string[]).includes(value)
    ? (value as GoogleConnectCode)
    : null;
}

export type BannerTone = "ok" | "warn" | "error";

// ── §9.1 Shared ─────────────────────────────────────────────────────────────

/** Keywords the "Text Aria" buttons prefill; the link tool answers each with a fresh link. */
export type LinkKeyword = "new link" | "setup" | "settings" | "draft link";

export const SHARED_COPY = {
  nav: { week: "Week", setup: "Setup", settings: "Settings", label: "Aria" },
  signedOut: {
    "new link": {
      title: "Open this from Aria.",
      body: "Aria signs you in with links it texts you. Tap your latest link from Aria, or text Aria \"new link\" to get one.",
      button: "Text Aria for a link",
      keyword: "new link" as LinkKeyword,
    },
    setup: {
      title: "Open this from Aria.",
      body: "Text Aria \"setup\" and tap the link it sends. Links work for 30 minutes.",
      button: "Text Aria \"setup\"",
      keyword: "setup" as LinkKeyword,
    },
    settings: {
      title: "Open this from Aria.",
      body: "Text Aria \"settings\" and tap the link it sends.",
      button: "Text Aria \"settings\"",
      keyword: "settings" as LinkKeyword,
    },
    pwa: {
      title: "Sign in through Messages.",
      body: "The Home Screen app can't use your Safari sign-in yet. Open your latest link from Aria in Safari, or text Aria \"new link\".",
      button: "Text Aria for a link",
      keyword: "new link" as LinkKeyword,
    },
  },
  freshLinkNeeded:
    "For your security, connecting or removing accounts needs a fresh link. Text Aria \"setup\" and open the link it sends within 15 minutes.",
  freshLinkButton: "Text Aria \"setup\"",
  freshUntil: (time: string) => `You can connect accounts until ${time}.`,
  recentLinkNeeded: (keyword: "draft link" | "settings") =>
    `This link is more than an hour old. Text Aria "${keyword}" for a fresh one, or reply in Messages instead.`,
  skew: { title: "Aria just updated.", body: "Reload the page and try again.", button: "Reload" },
  genericError: {
    title: "Something broke on our end.",
    body: "Your info is safe. Try again, or text Aria if it keeps happening.",
    button: "Try again",
  },
  notFound: {
    title: "Nothing here.",
    body: "This page doesn't exist, or the link is cut off. Text Aria \"new link\" for a fresh one.",
    home: "Go to aria home",
    button: "Text Aria for a link",
  },
  signedOutPage: { title: "You're signed out.", body: "To get back in, tap a link from Aria." },
  signOut: "Sign out on this phone",
  signOutEverywhere: {
    label: "Sign out everywhere",
    hint: "Signs out every browser that opened an Aria link. Your texts with Aria keep working.",
  },
  backToChat: "Back to Messages",
  offline: "You look offline. Check your connection and try again.",
  saving: "Saving…",
  saved: "Saved.",
} as const;

/** Canvas connect errors, plus the client-side pre-check `empty`. */
export const CANVAS_ERROR_COPY: Record<CanvasConnectErrorCode | "empty", string> = {
  empty: "Paste your Calendar Feed link first.",
  not_a_url:
    "That isn't a link. Copy the whole address from the Calendar Feed box. It starts with https:// or webcal://.",
  not_ical:
    "That's a Canvas page, not your calendar feed. The link should end in .ics. In Canvas, open Calendar, tap Calendar Feed, and copy the link in that box.",
  course_feed:
    "That's one course's feed. Copy the link under Calendar Feed on your Calendar page so Aria gets all your classes.",
  not_canvas: "That link isn't from Canvas. Copy it from Calendar Feed in your school's Canvas.",
  private_address: "That link isn't from Canvas. Copy it from Calendar Feed in your school's Canvas.",
  feed_not_found:
    "Canvas says that feed doesn't exist. It may have been reset. Copy a fresh link from Calendar Feed and paste it again.",
  unreachable: "Aria couldn't reach Canvas. Check the link, then try again in a minute.",
  timeout: "Canvas took too long to answer. Try again in a minute.",
  too_large:
    "Your calendar is bigger than Aria can read right now. Text Aria \"help\" and Daniel will sort it out.",
  forbidden:
    "Canvas wouldn't share that feed. Copy a fresh link from Calendar Feed and paste it again.",
  rate_limited: "Too many tries. Wait 10 minutes and try again.",
  already_connected_elsewhere:
    "That Canvas feed is already connected to another Aria account. Copy your own link from Calendar Feed.",
  not_user_authored: "Paste the link here yourself so Aria knows it's yours.",
  no_url_found: "Paste your Calendar Feed link first.",
  multiple_urls: "Paste just one link: the one from the Calendar Feed box.",
  internal: "Something broke on our end. Try again, and text Aria if it keeps happening.",
};

/** Copy for every `ActionErrorCode` (§9.1 plus the integration-specific codes). */
export const ACTION_ERROR_COPY: Record<ActionErrorCode, string> = {
  ...CANVAS_ERROR_COPY,
  signed_out: "You're signed out. Text Aria \"new link\" to sign back in.",
  needs_recent_link:
    "This link is more than an hour old. Text Aria \"settings\" for a fresh one, or reply in Messages instead.",
  needs_fresh_link: SHARED_COPY.freshLinkNeeded,
  bad_origin: "That request didn't come from this page. Reload the page and try again.",
  rate_limited: "Too many tries. Wait 10 minutes and try again.",
  invalid: "Something in that form isn't right. Check it and try again.",
  not_found: "Aria couldn't find that. It may have been deleted. Reload the page to see the latest.",
  version_conflict:
    "This draft changed in your chat with Aria. Here's the latest version. Check it, then send.",
  not_pending: "This draft was already sent or canceled.",
  expired: "This draft expired, so Aria didn't send it. Ask Aria to draft it again.",
  unavailable: "This part of Aria isn't ready yet. Text Aria to do it in chat.",
  server: "Something broke on our end. Try again, and text Aria if it keeps happening.",
  // Send
  same_run: "Aria needs you to confirm in a new message. Reply \"send it\" in Messages, or tap Send again.",
  executor_failed: "Gmail didn't accept the email, so it wasn't sent. Try again, or text Aria \"help\".",
  google_disconnected:
    "Aria can't send this because Google isn't connected. Connect it in Setup, then try again.",
  send_unconfirmed:
    "Gmail hasn't confirmed this one yet. It may already be sent — check your Sent folder before trying again.",
};

/**
 * Copy for an action error code.
 * @param code action error code
 * @returns user-facing sentence(s)
 */
export function actionErrorCopy(code: ActionErrorCode): string {
  return ACTION_ERROR_COPY[code] || ACTION_ERROR_COPY.server;
}

// ── §9.2 /setup ─────────────────────────────────────────────────────────────

/** Banner for each `?google=` callback code. `{email}`/`{missing}` are filled by the caller. */
export const GOOGLE_STATUS_COPY: Record<GoogleConnectCode, { tone: BannerTone; text: string }> = {
  connected: { tone: "ok", text: "Google connected as {email}." },
  missing_scopes: {
    tone: "warn",
    text: "Google connected, but some boxes were unchecked, so Aria can't {missing}. Tap Connect Google again and check every box.",
  },
  denied: { tone: "warn", text: "You canceled Google sign-in, so nothing changed. Tap Connect Google to try again." },
  admin_blocked: {
    tone: "error",
    text: "Your school's Google account blocks apps like Aria. Try a personal Gmail, or skip Google for now.",
  },
  stale: {
    tone: "warn",
    text: "That setup link is more than 15 minutes old. Text Aria \"setup\" for a fresh one, then tap Connect Google.",
  },
  expired: { tone: "warn", text: "That sign-in took too long. Tap Connect Google to start again." },
  account_in_use: {
    tone: "error",
    text: "That Google account is already connected to another Aria account. Connect a different one.",
  },
  error: { tone: "error", text: "Google sign-in didn't finish. Try again in a minute." },
};

export const SETUP_COPY = {
  title: "Set up Aria",
  intro:
    "Connect your accounts so Aria knows what's due and when you're free. You can change any of this later in Settings.",
  canvas: {
    title: "Canvas",
    connected: "Connected",
    notConnected: "Not connected",
    intro:
      "Aria reads your Canvas calendar feed: assignments, quizzes, and exams with their due dates. It can't see your grades or submissions.",
    schoolLabel: "Your school",
    schoolUnlisted: "My school isn't listed",
    customHostLabel: "Your Canvas address",
    customHostHint: "The part before the first slash when you open Canvas, like canvas.myschool.edu",
    guideTitle: "Get your Canvas calendar link",
    step1: "Open Canvas and go to Calendar.",
    step1Link: (host: string) => `Open ${host}/calendar`,
    step2: "Scroll down and tap Calendar Feed. A box with a link pops up.",
    step3: "Copy that whole link, come back here, and paste it below.",
    guideTip:
      "If the Canvas app opens instead of Safari, copy the address and paste it into Safari. It's easiest on a laptop.",
    copyAddress: "Copy Canvas address",
    copied: "Copied.",
    guideAlt: "Or paste the link straight into your chat with Aria.",
    pasteLabel: "Calendar Feed link",
    pastePlaceholder: "https://…/feeds/calendars/user_….ics",
    connect: "Connect Canvas",
    connectPending: "Checking your feed…",
    successSome: (n: number) =>
      `Canvas connected. Aria found ${n} ${n === 1 ? "thing" : "things"} due in the next two weeks.`,
    successNone: "Canvas connected. Nothing's due in the next two weeks. Aria checks Canvas every hour.",
    seeWeek: "See your week",
    connectedStatus: (host: string, time: string) => `Connected to ${host} · Last checked ${time}.`,
    useDifferent: "Use a different link",
    disconnect: "Disconnect",
    failing: (since: string) =>
      `Aria couldn't read your Canvas feed since ${since}. Paste a fresh Calendar Feed link to fix it.`,
    disconnectConfirm: {
      title: "Disconnect Canvas?",
      body: "Aria stops checking Canvas and removes your upcoming Canvas deadlines. Reminders tied to them are canceled.",
      confirm: "Disconnect",
      cancel: "Keep it",
    },
  },
  google: {
    title: "Google",
    connectedAs: (email: string) => `Connected as ${email}`,
    notConnected: "Not connected",
    intro:
      "Connect Gmail and Google Calendar so Aria can spot emails that need you, plan around your schedule, and draft replies.",
    reads:
      "Your Gmail inbox, to flag emails that matter (professors, deadline changes, recruiters) and to give drafts context. Your Google Calendar, to see classes and plans.",
    readsTitle: "What Aria reads:",
    does:
      "Adds study and gym blocks to its own calendar called \"Aria\", which you can hide or delete anytime. Sends an email only after you say \"send it\".",
    doesTitle: "What Aria does:",
    never:
      "Delete, archive, or change your emails. Edit events on your other calendars. Sell your data, use it for ads, or train AI models on it.",
    neverTitle: "What Aria never does:",
    aiProcessing:
      "To write replies, Aria sends the parts of your email and calendar it needs to its AI providers (Anthropic's Claude, with OpenAI as a backup). They don't train on it.",
    unverifiedTitle: "Google will show a warning.",
    unverified:
      "Aria is a small private test, so Google hasn't reviewed it yet. You'll see \"Google hasn't verified this app.\" To continue, tap Advanced, then Go to Aria (unsafe), then check every box. Only continue if you're comfortable with that.",
    ownAccount: "Connect only your own Google account.",
    schoolAccounts:
      "Some school Google accounts block apps like Aria. If yours does, use a personal Gmail or skip this step.",
    connect: "Connect Google",
    disconnect: "Disconnect Google",
    disconnectConfirm: {
      title: "Disconnect Google?",
      body: "Aria loses access to your Gmail and Calendar right away and deletes the emails and events it pulled in. The \"Aria\" calendar stays in your Google Calendar until you delete it.",
      confirm: "Disconnect",
      cancel: "Keep it",
    },
    capabilities: {
      readMail: "read your inbox",
      sendMail: "send emails you approve",
      readCalendar: "see your calendar",
      writeAriaCalendar: "add blocks to the \"Aria\" calendar",
    },
    missing: {
      readMail: "read your email",
      sendMail: "send email for you",
      readCalendar: "see your calendar",
      writeAriaCalendar: "add study blocks",
    },
    needsReconnect:
      "Google stopped working for Aria. This happens if you removed access in your Google account. Tap Connect Google to fix it.",
    /** Whose Aria this link opens (5.5 #13: a forwarded setup link signs you in as the sender). */
    textingAs: {
      label: "Texting as",
      phoneMasked: (last4: string) => `••• ••• ${last4}`,
      phoneSpoken: (last4: string) => `the number ending in ${last4}`,
      emailMasked: (domain: string) => `•••@${domain}`,
      emailSpoken: (domain: string) => `an Apple ID at ${domain}`,
      notYou:
        "Not you? Don't connect anything here. This link signs in whoever texted Aria for it. Text Aria \"setup\" from your own phone instead.",
    },
  },
  syllabus: {
    title: "Syllabi",
    intro:
      "Upload a course syllabus (PDF) and Aria pulls out exams, weights, and topics. You can also send the PDF to Aria in Messages.",
  },
  briefing: {
    title: "Morning briefing",
    label: "Send my briefing at",
    hint: "Aria texts you what's due and what's on your calendar.",
    off: "Don't send a briefing",
    timeZone: (label: string) => `Times are in ${label}.`,
    timeZoneMismatch: (label: string) => `This phone is set to ${label}.`,
    useTimeZone: (label: string) => `Use ${label}`,
  },
  quiet: {
    title: "Quiet hours",
    hint: "Aria won't text you first between these times. It still answers when you text it.",
    from: "From",
    until: "Until",
    overlap: (time: string) =>
      `Your briefing time is inside quiet hours, so it will arrive at ${time} instead.`,
  },
  save: { idle: "Save", pending: "Saving…", done: "Saved." },
  tone: { title: "How Aria talks" },
  footer: { prompt: "Done for now?", button: "Back to Messages" },
} as const;

// ── §9.3 /week ──────────────────────────────────────────────────────────────

export const WEEK_COPY = {
  title: (name: string | null) => (name ? `${name}'s week` : "Your week"),
  subtitle: (offsetWeeks: 0 | 1, tzLabel: string) =>
    `${offsetWeeks === 0 ? "Next 7 days" : "Following 7 days"} · ${tzLabel}`,
  weekLoad: { light: "Light week", busy: "Busy week", heavy: "Heavy week" },
  thingsDue: (n: number) => `${n} ${n === 1 ? "thing" : "things"} due`,
  stillOpen: { title: "Still open", hint: "Past due and not marked done" },
  dayLoadLabel: (level: "light" | "busy" | "heavy", n: number) =>
    level === "light" ? "Light day" : `${level === "busy" ? "Busy" : "Heavy"} day: ${n} ${n === 1 ? "thing" : "things"} due`,
  markDone: (title: string) => `Mark "${title}" done`,
  markNotDone: (title: string) => `Mark "${title}" not done`,
  done: "Done",
  undo: "Undo",
  openCanvas: "Open in Canvas",
  openGoogle: "Open in Google Calendar",
  nextWeek: "Next week →",
  thisWeek: "← This week",
  emptyNoCanvas: {
    title: "Connect Canvas and your deadlines show up here.",
    body: "It takes about a minute.",
    button: "Connect Canvas",
  },
  emptyConnected: { title: "Nothing due in the next 7 days.", body: "Aria checks Canvas every hour." },
  emptyDay: "Nothing due.",
  noGoogle: { text: "Connect Google to see your classes and plans here too.", button: "Set up Google" },
  syncFailing: (since: string) => `Aria couldn't read your Canvas feed since ${since}.`,
  syncFailingButton: "Fix it in Setup",
  markDoneError: "Couldn't save that. Try again.",
} as const;

// ── §9.4 /settings ──────────────────────────────────────────────────────────

export const SETTINGS_COPY = {
  title: "Settings",
  accounts: {
    title: "Connected accounts",
    canvasConnected: (host: string) => `Canvas: Connected to ${host}`,
    canvasNot: "Canvas: Not connected",
    googleConnected: (email: string) => `Google: Connected as ${email}`,
    googleNot: "Google: Not connected",
    manage: "Manage in Setup",
  },
  memory: {
    title: "What Aria knows about you",
    intro:
      "Aria remembers what you tell it in chat. It never learns from your emails, Canvas, or calendar. Edit or delete anything here, or text Aria \"forget …\".",
    profileTitle: "About you",
    name: "Name",
    school: "School",
    courses: "Courses",
    preferencesTitle: "How you like things",
    proposedTitle: "Aria's suggestions",
    proposedHint: "Aria noticed this but hasn't saved it as a rule yet.",
    keep: "Keep it",
    dontKeep: "Don't keep",
    factsTitle: "Things Aria remembers",
    savedOn: (date: string) => `Saved ${date}`,
    edit: "Edit",
    delete: "Delete",
    empty:
      "Aria doesn't remember anything about you yet. Tell it in chat, like \"I'm a night owl\" or \"sign my emails Best, Dan\".",
    deleteConfirm: { title: "Delete this? Aria will forget it.", confirm: "Delete", cancel: "Cancel" },
    editEmpty: "Write something, up to 280 characters.",
    editTooLong: "Keep it under 280 characters.",
    editNeedsRecent:
      "Editing needs a link from the last hour. Text Aria \"settings\" for a fresh one. You can still delete things.",
  },
  signOut: { title: "Sign out" },
  export: {
    title: "Your data",
    body: "Download everything Aria has stored about you as a JSON file: your profile, messages from the last 180 days, deadlines, reminders, and memories.",
    button: "Download my data",
    needsFresh:
      "Downloading your data needs a fresh link. Text Aria \"settings\" and open the link within 15 minutes.",
  },
  deleteAccount: {
    title: "Delete my account",
    body: "Aria deletes your messages, deadlines, memories, and settings right away, disconnects Google and Canvas, and stops texting you. This can't be undone.",
    dialogTitle: "Delete your Aria account?",
    dialogBody: "Type delete to confirm.",
    confirm: "Delete my account",
    cancel: "Keep my account",
    typeError: "Type delete to confirm.",
    needsFresh:
      "Deleting your account needs a fresh link. Text Aria \"settings\" and open the link within 15 minutes.",
  },
  deletedPage: {
    title: "Your account is deleted.",
    body: "Aria removed your data and disconnected your accounts. If you text Aria again, it starts fresh.",
    revokeFailed:
      "One more step: Google didn't confirm the disconnect. Remove Aria at myaccount.google.com/permissions.",
    revokeButton: "Open Google permissions",
  },
} as const;

// ── §9.5 /email/[id] ────────────────────────────────────────────────────────

export const EMAIL_COPY = {
  title: "Email draft",
  from: "From",
  to: "To",
  cc: "Cc",
  recipientsHint: "To change who this goes to, tell Aria in Messages.",
  subjectLabel: "Subject",
  bodyLabel: "Message",
  expires: (time: string) => `This draft expires at ${time}.`,
  save: { idle: "Save changes", pending: "Saving…", done: "Saved." },
  send: { idle: "Send email", pending: "Sending…" },
  sendBlockedDirty: "Save your changes before sending.",
  sent: (time: string) => `Sent at ${time}. Aria also confirmed it in Messages.`,
  cancel: {
    button: "Cancel draft",
    title: "Cancel this draft?",
    body: "Aria won't send it.",
    confirm: "Cancel draft",
    keep: "Keep it",
  },
  cancelled: "You canceled this draft. Ask Aria for a new one anytime.",
  expired: "This draft expired, so Aria didn't send it. Ask Aria to draft it again.",
  failed: "Gmail didn't accept the email, so it wasn't sent. Try again, or text Aria \"help\".",
  originalEmail: "Show the email you're replying to",
  subjectTooLong: "Subjects can't be longer than 250 characters.",
} as const;
