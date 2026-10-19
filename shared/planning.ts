/** Contract of the planning module: website, Telegram and future agents use the same shapes. */

/** Who set the fields of a record. Parser and AI values are shown to the user before saving. */
export type PlanningSource = 'manual' | 'parser' | 'ai' | 'google' | 'yandex'
export type CalendarProvider = 'google' | 'yandex'

/**
 * Timed events store UTC instants (`2026-10-20T07:00:00.000Z`) and an IANA zone for recurrence and display.
 * All-day events store dates (`2026-10-20`); the end date is exclusive, as in iCalendar.
 */
export type PlanningEvent = {
  id: string
  title: string
  description: string
  location: string
  allDay: boolean
  start: string
  end: string
  timeZone: string
  /** RRULE value without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO`. */
  rrule: string | null
  /** Excluded occurrence starts, same format as `start`. */
  exdates: string[]
  /** Minutes before start; null uses the profile default, a negative value disables the reminder. */
  reminderMinutes: number | null
  /** Connected calendar; null keeps the event only in this application. */
  calendarId: string | null
  source: PlanningSource
  /** Imported data that can only be changed in the source calendar. */
  readOnly: boolean
  /** A changed or cancelled single occurrence of another event. */
  recurrenceOf: string | null
  recurrenceId: string | null
  cancelled: boolean
  createdAt: string
  updatedAt: string
}

export type EventInput = {
  title: string
  description?: string
  location?: string
  allDay?: boolean
  start: string
  end: string
  timeZone?: string
  rrule?: string | null
  exdates?: string[]
  reminderMinutes?: number | null
  calendarId?: string | null
}

export type TaskPriority = 1 | 2 | 3
export type PlanningTask = {
  id: string
  title: string
  notes: string
  project: string
  /** Date `2026-10-25` or UTC instant when `dueHasTime`. */
  due: string | null
  dueHasTime: boolean
  /** Optional fixed recurrence zone; older tasks use the profile's current zone. */
  timeZone?: string
  durationMinutes: number | null
  priority: TaskPriority
  status: 'open' | 'done'
  completedAt: string | null
  /** Repeating obligation: completing it creates the next task with the next deadline. */
  rrule: string | null
  /** Minutes before a timed deadline; null uses the profile default, negative disables. */
  reminderMinutes: number | null
  source: PlanningSource
  createdAt: string
  updatedAt: string
}

export type TaskInput = {
  title: string
  notes?: string
  project?: string
  due?: string | null
  dueHasTime?: boolean
  timeZone?: string
  durationMinutes?: number | null
  priority?: TaskPriority
  status?: 'open' | 'done'
  reminderMinutes?: number | null
  rrule?: string | null
}

/** One concrete occurrence of an event inside a requested range. */
export type Occurrence = {
  eventId: string
  title: string
  location: string
  start: string
  end: string
  allDay: boolean
  calendarId: string | null
  source: PlanningSource
  recurring: boolean
  readOnly: boolean
}

export type TimeSlot = { start: string; end: string; minutes: number }
export type Conflict = { first: Occurrence; second: Occurrence; overlapMinutes: number }

export type DayBrief = {
  date: string
  timeZone: string
  generatedAt: string
  events: Occurrence[]
  allDay: Occurrence[]
  tasksDue: PlanningTask[]
  overdue: PlanningTask[]
  conflicts: Conflict[]
  freeSlots: TimeSlot[]
  busyMinutes: number
  freeMinutes: number
  plannedTaskMinutes: number
  /** Tasks with known duration do not fit into free working time. */
  overload: boolean
  /** Ready-made plain text for Telegram and the morning report. */
  text: string
}

export type AgendaDay = { date: string; occurrences: Occurrence[]; tasks: PlanningTask[] }
export type Agenda = { from: string; days: AgendaDay[]; undated: PlanningTask[]; overdue: PlanningTask[] }

export type DraftItem = {
  kind: 'event' | 'task'
  title: string
  /** Event fields. */
  start?: string
  end?: string
  allDay?: boolean
  rrule?: string | null
  /** Task fields. */
  due?: string | null
  dueHasTime?: boolean
  durationMinutes?: number | null
  reminderMinutes?: number | null
  /** What the system assumed, e.g. "«в 3» понято как 15:00". */
  assumptions: string[]
  /** Required values that are still unknown; the item cannot be saved until they are filled. */
  missing: string[]
  conflicts: Occurrence[]
}

/** `agent`: proposed by the planning agent; times placed or checked by code. */
export type DraftMethod = 'parser' | 'ai' | 'parser+ai' | 'agent'
export type PlanningDraft = {
  id: string
  text: string
  items: DraftItem[]
  method: DraftMethod
  /** Clarifying question when the request is ambiguous. */
  question: string | null
  /** Why the model was or was not used. */
  notes: string[]
  createdAt: string
}

export type DraftConfirmation = { created: { events: PlanningEvent[]; tasks: PlanningTask[] } }

export type PlanningSettings = {
  timeZone: string
  briefEnabled: boolean
  /** Local time `HH:MM`. */
  briefTime: string
  defaultReminderMinutes: number
  taskReminderMinutes: number
  workStart: string
  workEnd: string
  syncIntervalMinutes: number
  /** New events from the website and Telegram go to this connected calendar. */
  defaultCalendarId: string | null
}

export type ConnectedCalendar = {
  id: string
  accountId: string
  remoteId: string
  name: string
  color: string
  writable: boolean
  /** Two-way synchronization is enabled for this calendar. */
  enabled: boolean
}

export type CalendarAccount = {
  id: string
  provider: CalendarProvider
  label: string
  status: 'ok' | 'error' | 'needs_auth'
  lastSyncAt: string | null
  lastError: string | null
  calendars: ConnectedCalendar[]
  createdAt: string
}

export type SyncConflict = {
  eventId: string
  title: string
  /** Which version was kept. */
  kept: 'local' | 'remote'
  reason: string
}

export type SyncCounts = { created: number; updated: number; deleted: number }
export type SyncReport = {
  accountId: string
  calendarId: string
  calendarName: string
  at: string
  pulled: SyncCounts
  pushed: SyncCounts
  conflicts: SyncConflict[]
  errors: string[]
}

export type TelegramChat = { chatId: string; title: string; linkedAt: string }
export type TelegramStatus = {
  configured: boolean
  /** The project bot comes from TELEGRAM_BOT_TOKEN and starts with the service; users only link chats. */
  managed: boolean
  running: boolean
  botUsername: string | null
  error: string | null
  chats: TelegramChat[]
}
export type TelegramLink = { code: string; url: string | null; expiresAt: string }

export type GoogleConfig = { configured: boolean; clientIdPreview: string | null; redirectUri: string }

export type PlanningCapabilities = {
  ai: { configured: boolean; provider: 'ollama' | 'openrouter' | null; model: string | null }
  google: GoogleConfig
  telegram: TelegramStatus
  timeZones: string[]
}

/** Planning assistant: a rule-based dispatcher answers simple requests; the agent handles the rest. */
export type AssistantRoute = 'day_plan' | 'week' | 'free_slots' | 'tasks' | 'draft' | 'agent' | 'help'
export type AssistantTurn = { role: 'user' | 'assistant'; content: string }
export type AssistantRequest = {
  message: string
  /** Previous turns of this conversation, newest last; used for follow-up questions. */
  history?: AssistantTurn[]
  /** `agent` skips the dispatcher and always asks the model. */
  mode?: 'auto' | 'agent'
}
export type AssistantStep = { tool: string; status: 'ok' | 'error'; summary: string; durationMs: number }
export type AssistantReply = {
  id: string
  message: string
  route: AssistantRoute
  answer: string
  /** Proposed events and tasks; nothing is saved until the user confirms the draft. */
  draft: PlanningDraft | null
  steps: AssistantStep[]
  model: string | null
  /** Why this route was chosen and what limited the agent. */
  notes: string[]
  createdAt: string
}
