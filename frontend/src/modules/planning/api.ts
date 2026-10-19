import type {
  Agenda, AssistantReply, AssistantTurn, CalendarAccount, DayBrief, DraftConfirmation, DraftItem, EventInput, GoogleConfig, PlanningCapabilities, PlanningDraft,
  PlanningEvent, PlanningSettings, PlanningTask, SyncReport, TaskInput, TelegramLink, TelegramStatus,
} from '../../../../shared/planning'
import { workspaceProfile } from '../../lib/profile'

const base = '/api/planning'

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const profileQuery = workspaceProfile() === 'demo' ? `${path.includes('?') ? '&' : '?'}profileId=demo` : ''
  const response = await fetch(`${base}${path}${profileQuery}`, {
    ...rest,
    ...(json !== undefined || (rest.method && rest.method !== 'GET' && rest.method !== 'DELETE') ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json ?? {}) } : {}),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data === null) throw new Error(data?.error || 'Раздел недоступен. Проверьте, что backend запущен.')
  return data as T
}

export const planningApi = {
  capabilities: (signal?: AbortSignal) => request<PlanningCapabilities>('/capabilities', { signal }),
  settings: (signal?: AbortSignal) => request<PlanningSettings>('/settings', { signal }),
  saveSettings: (value: Partial<PlanningSettings>) => request<PlanningSettings>('/settings', { method: 'PUT', json: value }),

  brief: (date: string, signal?: AbortSignal) => request<DayBrief>(`/brief?date=${date}`, { signal }),
  agenda: (from: string, days: number, signal?: AbortSignal) => request<Agenda>(`/agenda?from=${from}&days=${days}`, { signal }),

  event: (id: string) => request<PlanningEvent>(`/events/${encodeURIComponent(id)}`),
  createEvent: (value: EventInput) => request<PlanningEvent>('/events', { method: 'POST', json: value }),
  updateEvent: (id: string, value: Partial<EventInput>) => request<PlanningEvent>(`/events/${encodeURIComponent(id)}`, { method: 'PUT', json: value }),
  deleteEvent: (id: string) => request<{ deleted: boolean }>(`/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  skipOccurrence: (id: string, start: string) => request<PlanningEvent>(`/events/${encodeURIComponent(id)}/skip`, { method: 'POST', json: { start } }),

  tasks: (signal?: AbortSignal) => request<PlanningTask[]>('/tasks', { signal }),
  createTask: (value: TaskInput) => request<PlanningTask>('/tasks', { method: 'POST', json: value }),
  updateTask: (id: string, value: Partial<TaskInput>) => request<PlanningTask>(`/tasks/${encodeURIComponent(id)}`, { method: 'PUT', json: value }),
  completeTask: (id: string) => request<{ task: PlanningTask; next: PlanningTask | null }>(`/tasks/${encodeURIComponent(id)}/complete`, { method: 'POST' }),
  deleteTask: (id: string) => request<{ deleted: boolean }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  ask: (message: string, history: AssistantTurn[], mode: 'auto' | 'agent', signal?: AbortSignal) => request<AssistantReply>('/assistant', { method: 'POST', json: { message, history, mode }, signal }),
  createDraft: (text: string, options: { useAi: boolean; force?: boolean }, signal?: AbortSignal) => request<PlanningDraft>('/drafts', { method: 'POST', json: { text, useAi: options.useAi, force: Boolean(options.force) }, signal }),
  confirmDraft: (id: string, items?: DraftItem[]) => request<DraftConfirmation>(`/drafts/${id}/confirm`, { method: 'POST', json: items ? { items } : {} }),
  cancelDraft: (id: string) => request<{ deleted: boolean }>(`/drafts/${id}`, { method: 'DELETE' }),

  accounts: (signal?: AbortSignal) => request<CalendarAccount[]>('/accounts', { signal }),
  deleteAccount: (id: string) => request<{ deleted: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
  syncAccount: (id: string) => request<SyncReport[]>(`/accounts/${id}/sync`, { method: 'POST' }),
  refreshCalendars: (id: string) => request<CalendarAccount>(`/accounts/${id}/refresh`, { method: 'POST' }),
  localEventsCount: (signal?: AbortSignal) => request<{ count: number }>('/events/local', { signal }),
  moveLocalEvents: (calendarId: string) => request<{ moved: number }>(`/calendars/${calendarId}/move-local`, { method: 'POST' }),
  setCalendarEnabled: (id: string, enabled: boolean) => request<CalendarAccount[]>(`/calendars/${id}`, { method: 'PUT', json: { enabled } }),
  syncLog: (signal?: AbortSignal) => request<SyncReport[]>('/sync/log', { signal }),
  connectYandex: (value: { login: string; password: string; calendarUrl?: string }) => request<CalendarAccount>('/yandex/connect', { method: 'POST', json: value }),

  googleConfig: () => request<GoogleConfig>('/google/config'),
  saveGoogleConfig: (value: { clientId: string; clientSecret: string }) => request<GoogleConfig>('/google/config', { method: 'PUT', json: value }),
  googleStart: () => request<{ url: string }>('/google/start', { method: 'POST' }),

  telegram: (signal?: AbortSignal) => request<TelegramStatus>('/telegram', { signal }),
  configureTelegram: (token: string) => request<TelegramStatus>('/telegram', { method: 'PUT', json: { token } }),
  removeTelegram: () => request<TelegramStatus>('/telegram', { method: 'DELETE' }),
  telegramLink: () => request<TelegramLink>('/telegram/link', { method: 'POST' }),
  telegramTest: () => request<{ sent: number }>('/telegram/test', { method: 'POST' }),
  unlinkChat: (chatId: string) => request<TelegramStatus>(`/telegram/chats/${chatId}`, { method: 'DELETE' }),
}
