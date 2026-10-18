import { randomBytes, randomUUID } from 'node:crypto'
import type { AssistantReply, CalendarAccount, DraftConfirmation, DraftItem, GoogleConfig, Occurrence, PlanningCapabilities, PlanningDraft, PlanningEvent, PlanningSettings, PlanningSource, PlanningTask, TelegramLink, TelegramStatus } from '../../../shared/planning.js'
import type { TelegramService } from '../telegram/service.js'
import { agenda, dayBrief } from './agenda.js'
import { CalDavClient, yandexCalDavUrl } from './caldav.js'
import { answerRequest } from './agent.js'
import { DraftExtractor } from './extract.js'
import type { ToolModel } from './model.js'
import { GoogleCalendarClient, GoogleOAuth, type GoogleClientConfig, type GoogleTokens } from './google.js'
import { bounds, expandEvents, nextOccurrence } from './recurrence.js'
import { calendarPatchSchema, confirmSchema, draftRequestSchema, eventInputSchema, eventPatchSchema, googleConfigSchema, PlanningError, settingsSchema, taskInputSchema, taskPatchSchema, telegramTokenSchema, yandexConnectSchema } from './schema.js'
import type { AccountRecord, PlanningStore } from './store.js'
import { AuthError, SyncEngine, type CalendarClient } from './sync.js'
import { addDays, dayRange, isDateKey, localDate, parseDateKey } from './time.js'

type YandexSecret = { login: string; password: string; calendarUrl?: string }
export type PlanningOptions = { clock?: () => Date; telegram?: TelegramService; publicUrl?: string; fetcher?: typeof fetch; yandexUrl?: string; agentModel?: ToolModel }

export class PlanningService {
  readonly sync: SyncEngine
  private clock: () => Date
  private fetcher: typeof fetch
  private oauthStates = new Map<string, { profileId: string; expires: number }>()
  private pendingSync = new Map<string, NodeJS.Timeout>()
  private assistantRuns = 0
  readonly publicUrl: string
  readonly telegram?: TelegramService

  constructor(readonly store: PlanningStore, readonly extractor = new DraftExtractor(), private options: PlanningOptions = {}) {
    this.clock = options.clock || (() => new Date())
    this.fetcher = options.fetcher || fetch
    this.publicUrl = (options.publicUrl || 'http://localhost:5173').replace(/\/$/, '')
    this.telegram = options.telegram
    this.sync = new SyncEngine(store, (account) => this.clientFor(account), this.clock)
  }

  close() { for (const timer of this.pendingSync.values()) clearTimeout(timer); this.store.close() }
  now() { return this.clock() }

  capabilities(): PlanningCapabilities {
    const model = this.extractor.modelInfo
    return { ai: { configured: Boolean(model), provider: model?.provider ?? null, model: model?.model ?? null }, google: this.googleConfig(), telegram: this.telegramStatus('default'), timeZones: Intl.supportedValuesOf('timeZone') }
  }

  // Settings
  settings(profileId: string) { return this.store.settings(profileId) }
  saveSettings(profileId: string, input: unknown): PlanningSettings {
    const patch = settingsSchema.parse(input)
    const next = { ...this.store.settings(profileId), ...patch }
    if (next.workStart >= next.workEnd) throw new PlanningError('Начало рабочего дня должно быть раньше окончания')
    if (next.defaultCalendarId) this.writableCalendar(profileId, next.defaultCalendarId)
    return this.store.saveSettings(profileId, next)
  }
  private writableCalendar(profileId: string, id: string) {
    const calendar = this.store.calendarRecord(id)
    if (!calendar || calendar.profileId !== profileId) throw new PlanningError('Календарь не найден', 404)
    if (!calendar.writable) throw new PlanningError(`В календарь «${calendar.name}» нельзя записывать`)
    if (!calendar.enabled) throw new PlanningError(`Синхронизация календаря «${calendar.name}» выключена`)
    return calendar
  }

  // Events
  occurrences(profileId: string, from: Date, to: Date) {
    return expandEvents(this.store.events(profileId), from, to, this.store.settings(profileId).timeZone)
  }
  event(profileId: string, id: string) {
    const event = this.store.event(profileId, id)
    if (!event) throw new PlanningError('Событие не найдено', 404)
    return event
  }
  createEvent(profileId: string, input: unknown, source: PlanningSource = 'manual'): PlanningEvent {
    const value = eventInputSchema.parse(input)
    const settings = this.store.settings(profileId)
    const calendarId = value.calendarId === undefined ? settings.defaultCalendarId : value.calendarId
    if (calendarId) this.writableCalendar(profileId, calendarId)
    const at = this.clock().toISOString()
    const event: PlanningEvent = {
      id: randomUUID(), title: value.title, description: value.description, location: value.location, allDay: value.allDay, start: value.start, end: value.end,
      timeZone: value.timeZone || settings.timeZone, rrule: value.rrule, exdates: value.exdates, reminderMinutes: value.reminderMinutes, calendarId,
      source, readOnly: false, recurrenceOf: null, recurrenceId: null, cancelled: false, createdAt: at, updatedAt: at,
    }
    this.store.saveEvent(profileId, event)
    this.afterLocalChange(event.calendarId)
    return event
  }
  updateEvent(profileId: string, id: string, input: unknown): PlanningEvent {
    const current = this.event(profileId, id)
    if (current.readOnly) throw new PlanningError('Это событие можно изменить только в исходном календаре', 409)
    const patch = eventPatchSchema.parse(input)
    if (patch.calendarId !== undefined && patch.calendarId !== current.calendarId && this.store.eventRow(profileId, id)?.link) throw new PlanningError('Перенос события между внешними календарями пока не поддерживается: создайте событие в нужном календаре', 409)
    if (patch.calendarId) this.writableCalendar(profileId, patch.calendarId)
    if (current.recurrenceOf && (patch.rrule || patch.exdates)) throw new PlanningError('У отдельного повторения нельзя задать собственное правило', 400)
    const merged = { ...current, ...patch }
    const value = eventInputSchema.parse({ title: merged.title, description: merged.description, location: merged.location, allDay: merged.allDay, start: merged.start, end: merged.end, timeZone: merged.timeZone, rrule: merged.rrule, exdates: merged.exdates, reminderMinutes: merged.reminderMinutes, calendarId: merged.calendarId })
    const event: PlanningEvent = { ...current, ...value, calendarId: merged.calendarId, timeZone: value.timeZone || current.timeZone, updatedAt: this.clock().toISOString() }
    this.store.saveEvent(profileId, event)
    this.afterLocalChange(event.calendarId)
    return event
  }
  deleteEvent(profileId: string, id: string) {
    const current = this.event(profileId, id)
    if (current.readOnly) throw new PlanningError('Это событие можно удалить только в исходном календаре', 409)
    this.store.deleteEvent(profileId, id)
    this.afterLocalChange(current.calendarId)
    return { deleted: true }
  }
  /** Remove one occurrence of a series, as «delete only this one» in calendar apps. */
  skipOccurrence(profileId: string, id: string, occurrenceStart: string) {
    const current = this.event(profileId, id)
    if (!current.rrule) throw new PlanningError('Событие не повторяется')
    const value = isDateKey(occurrenceStart) ? occurrenceStart : new Date(occurrenceStart).toISOString()
    if (current.exdates.includes(value)) return current
    return this.updateEvent(profileId, id, { exdates: [...current.exdates, value] })
  }

  /** Push local edits soon instead of waiting for the next periodic synchronization. */
  private afterLocalChange(calendarId: string | null) {
    if (!calendarId) return
    const calendar = this.store.calendarRecord(calendarId)
    if (!calendar) return
    clearTimeout(this.pendingSync.get(calendar.accountId))
    this.pendingSync.set(calendar.accountId, setTimeout(() => {
      this.pendingSync.delete(calendar.accountId)
      const account = this.store.accountRecord(calendar.accountId)
      if (account) void this.sync.syncAccount(account).catch(() => undefined)
    }, 1500).unref())
  }

  // Tasks
  tasks(profileId: string) { return this.store.tasks(profileId) }
  task(profileId: string, id: string) {
    const task = this.store.task(profileId, id)
    if (!task) throw new PlanningError('Задача не найдена', 404)
    return task
  }
  createTask(profileId: string, input: unknown, source: PlanningSource = 'manual'): PlanningTask {
    const value = taskInputSchema.parse(input)
    const at = this.clock().toISOString()
    return this.store.saveTask(profileId, { id: randomUUID(), ...value, completedAt: value.status === 'done' ? at : null, source, createdAt: at, updatedAt: at })
  }
  updateTask(profileId: string, id: string, input: unknown) {
    const current = this.task(profileId, id)
    const patch = taskPatchSchema.parse(input)
    if (patch.status === 'done' && current.status === 'open') return this.completeTask(profileId, id).task
    const merged = { ...current, ...patch }
    const value = taskInputSchema.parse({ title: merged.title, notes: merged.notes, project: merged.project, due: merged.due, durationMinutes: merged.durationMinutes, priority: merged.priority, status: merged.status, reminderMinutes: merged.reminderMinutes, rrule: merged.rrule })
    return this.store.saveTask(profileId, { ...current, ...value, completedAt: value.status === 'done' ? current.completedAt || this.clock().toISOString() : null, updatedAt: this.clock().toISOString() })
  }
  /** A repeating obligation creates its next instance with the next deadline. */
  completeTask(profileId: string, id: string): { task: PlanningTask; next: PlanningTask | null } {
    const current = this.task(profileId, id)
    if (current.status === 'done') return { task: current, next: null }
    const at = this.clock().toISOString()
    const task = this.store.saveTask(profileId, { ...current, status: 'done', completedAt: at, updatedAt: at })
    let next: PlanningTask | null = null
    if (current.rrule && current.due) {
      const due = nextOccurrence(current.rrule, current.due, this.store.settings(profileId).timeZone)
      if (due) next = this.store.saveTask(profileId, { ...current, id: randomUUID(), due, status: 'open', completedAt: null, createdAt: at, updatedAt: at })
    }
    return { task, next }
  }
  deleteTask(profileId: string, id: string) {
    if (!this.store.deleteTask(profileId, id)) throw new PlanningError('Задача не найдена', 404)
    return { deleted: true }
  }

  // Plans
  today(profileId: string) { return localDate(this.clock(), this.store.settings(profileId).timeZone) }
  brief(profileId: string, date = this.today(profileId)) {
    parseDateKey(date)
    return dayBrief(this.store.events(profileId), this.store.tasks(profileId), date, this.store.settings(profileId), this.clock())
  }
  agenda(profileId: string, from = this.today(profileId), days = 7) {
    parseDateKey(from)
    if (!Number.isInteger(days) || days < 1 || days > 42) throw new PlanningError('Период: от 1 до 42 дней')
    return agenda(this.store.events(profileId), this.store.tasks(profileId), from, days, this.store.settings(profileId), this.clock())
  }

  // Drafts: free text → proposal → explicit confirmation
  async createDraft(profileId: string, input: unknown): Promise<PlanningDraft> {
    const request = draftRequestSchema.parse(input)
    const settings = this.store.settings(profileId)
    if (request.force && !this.extractor.modelInfo) throw new PlanningError('Модель не настроена на сервере: задайте PLANNING_LLM_MODEL в backend/.env и перезапустите backend', 409)
    const result = await this.extractor.extract(request.text, { now: this.clock(), timeZone: settings.timeZone }, { useAi: request.useAi || request.force, force: request.force })
    const items: DraftItem[] = result.items.map(({ vague: _vague, compound: _compound, recognized: _recognized, ...item }) => ({ ...item, conflicts: this.conflictsFor(profileId, item) }))
    const draft: PlanningDraft = { id: randomUUID(), text: request.text, items, method: result.method, question: result.question, notes: result.notes, createdAt: this.clock().toISOString() }
    return this.store.saveDraft(profileId, draft)
  }
  conflictsFor(profileId: string, item: Pick<DraftItem, 'kind' | 'start' | 'end' | 'allDay'>): Occurrence[] {
    if (item.kind !== 'event' || !item.start || !item.end || item.allDay) return []
    const timeZone = this.store.settings(profileId).timeZone
    const range = bounds({ start: item.start, end: item.end, allDay: false }, timeZone)
    return this.occurrences(profileId, range.start, range.end).filter((value) => !value.allDay).slice(0, 5)
  }
  /** Store a draft proposed by the agent; it is confirmed by the same endpoint as any other draft. */
  saveProposal(profileId: string, text: string, items: DraftItem[], notes: string[]) {
    return this.store.saveDraft(profileId, { id: randomUUID(), text: text.slice(0, 1000), items, method: 'agent', question: null, notes, createdAt: this.clock().toISOString() })
  }

  /** Assistant: dispatcher on rules, agent with tools for the rest. At most two model runs at once. */
  async ask(profileId: string, input: unknown): Promise<AssistantReply> {
    if (this.assistantRuns >= 2) throw new PlanningError('Ассистент уже отвечает на два запроса. Повторите через минуту.', 429)
    this.assistantRuns++
    try { return await answerRequest(this, profileId, input, this.options.agentModel) } finally { this.assistantRuns-- }
  }
  get agentModel() { return this.options.agentModel ? { provider: this.options.agentModel.provider, model: this.options.agentModel.model } : null }

  draft(profileId: string, id: string) {
    const draft = this.store.draft(profileId, id)
    if (!draft) throw new PlanningError('Черновик не найден или устарел. Отправьте сообщение ещё раз.', 404)
    return draft
  }
  cancelDraft(profileId: string, id: string) { return { deleted: this.store.deleteDraft(profileId, id) } }
  confirmDraft(profileId: string, id: string, input: unknown = {}): DraftConfirmation {
    const draft = this.draft(profileId, id)
    const { items: edited } = confirmSchema.parse(input)
    const items = edited ?? draft.items
    // Provenance follows how the draft was produced, even if the user corrected fields before saving.
    const source: PlanningSource = draft.method === 'parser' ? 'parser' : 'ai'
    const untouched = edited ? [] : draft.items.filter((item) => item.missing.length)
    if (untouched.length) throw new PlanningError(`Уточните ${untouched[0].missing.join(' и ')} для «${untouched[0].title}»`, 422)
    // Validate everything first, then write: a confirmation is all-or-nothing.
    const events = items.filter((item) => item.kind === 'event').map((item) => {
      if (!item.start) throw new PlanningError(`Укажите дату для «${item.title}»`, 422)
      const allDay = item.allDay ?? isDateKey(item.start)
      if (!allDay && isDateKey(item.start)) throw new PlanningError(`Укажите время для «${item.title}»`, 422)
      const end = item.end ?? (allDay ? addDays(item.start, 1) : new Date(Date.parse(item.start) + (item.durationMinutes || 60) * 60000).toISOString())
      return eventInputSchema.parse({ title: item.title, allDay, start: item.start, end, rrule: item.rrule ?? null })
    })
    const tasks = items.filter((item) => item.kind === 'task').map((item) => taskInputSchema.parse({ title: item.title, due: item.due ?? null, durationMinutes: item.durationMinutes ?? null, reminderMinutes: item.reminderMinutes ?? null, rrule: item.rrule ?? null }))
    const created = { events: events.map((value) => this.createEvent(profileId, value, source)), tasks: tasks.map((value) => this.createTask(profileId, value, source)) }
    this.store.deleteDraft(profileId, id)
    return { created }
  }

  // External calendars
  accounts(profileId: string): CalendarAccount[] { return this.store.accounts(profileId) }
  private clientFor(account: AccountRecord): CalendarClient {
    const timeZone = this.store.settings(account.profileId).timeZone
    if (account.provider === 'yandex') {
      const secret = this.store.accountSecret<YandexSecret>(account.id)
      return new CalDavClient(secret.login, secret.password, timeZone, this.options.yandexUrl || yandexCalDavUrl, this.fetcher, secret.calendarUrl)
    }
    const config = this.store.secret<GoogleClientConfig>('google-client')
    if (!config) throw new AuthError('Не заданы Client ID и Client Secret Google')
    return new GoogleCalendarClient(this.oauth(config), this.store.accountSecret<GoogleTokens>(account.id), (tokens) => this.store.updateAccountSecret(account.id, tokens), timeZone, this.fetcher)
  }
  private oauth(config: GoogleClientConfig) { return new GoogleOAuth(config, `${this.publicUrl}/api/planning/google/callback`, this.fetcher) }

  async connectYandex(profileId: string, input: unknown) {
    const value = yandexConnectSchema.parse(input)
    let calendarUrl: string | undefined
    if (value.calendarUrl) {
      const url = (() => { try { return new URL(value.calendarUrl!) } catch { return null } })()
      if (!url || url.origin !== new URL(this.options.yandexUrl || yandexCalDavUrl).origin) throw new PlanningError('Ссылка должна начинаться с https://caldav.yandex.ru/')
      calendarUrl = url.toString()
    }
    const login = value.login.includes('@') ? value.login : `${value.login}@yandex.ru`
    const client = new CalDavClient(login, value.password, this.store.settings(profileId).timeZone, this.options.yandexUrl || yandexCalDavUrl, this.fetcher, calendarUrl)
    let calendars
    try { calendars = await client.listCalendars() } catch (error) {
      if (error instanceof AuthError) throw new PlanningError('Яндекс не принял логин или пароль приложения. Пароль приложения создаётся отдельно от пароля аккаунта — см. шаг 2.', 401)
      throw new PlanningError(`Не удалось получить список календарей: ${error instanceof Error ? error.message : 'ошибка'}`, 502)
    }
    if (!calendars.length) throw new PlanningError('В аккаунте не найдено календарей', 404)
    const account = this.store.saveAccount(profileId, 'yandex', login, { login, password: value.password, calendarUrl } satisfies YandexSecret)
    this.store.upsertCalendars(account, calendars)
    this.ensureDefaultCalendar(profileId)
    void this.sync.syncAccount(account).catch(() => undefined)
    return this.store.accounts(profileId).find((item) => item.id === account.id)!
  }

  googleConfig(): GoogleConfig {
    const config = this.store.secret<GoogleClientConfig>('google-client')
    return { configured: Boolean(config), clientIdPreview: config ? `${config.clientId.slice(0, 12)}…` : null, redirectUri: `${this.publicUrl}/api/planning/google/callback` }
  }
  saveGoogleConfig(input: unknown) {
    this.store.setSecret('google-client', googleConfigSchema.parse(input))
    return this.googleConfig()
  }
  googleStart(profileId: string) {
    const config = this.store.secret<GoogleClientConfig>('google-client')
    if (!config) throw new PlanningError('Сначала сохраните Client ID и Client Secret')
    const state = randomBytes(24).toString('base64url')
    const now = this.clock().getTime()
    for (const [key, item] of this.oauthStates) if (item.expires < now) this.oauthStates.delete(key)
    this.oauthStates.set(state, { profileId, expires: now + 10 * 60000 })
    return { url: this.oauth(config).authUrl(state) }
  }
  async googleCallback(code: string, state: string) {
    const pending = this.oauthStates.get(state)
    this.oauthStates.delete(state)
    if (!pending || pending.expires < this.clock().getTime()) throw new PlanningError('Ссылка входа устарела. Нажмите «Войти через Google» ещё раз.', 400)
    const config = this.store.secret<GoogleClientConfig>('google-client')
    if (!config) throw new PlanningError('Не заданы Client ID и Client Secret')
    const tokens = await this.oauth(config).exchange(code)
    const account = this.store.saveAccount(pending.profileId, 'google', tokens.email, tokens)
    const client = this.clientFor(account)
    this.store.upsertCalendars(account, await client.listCalendars())
    this.ensureDefaultCalendar(pending.profileId)
    void this.sync.syncAccount(account).catch(() => undefined)
    return account
  }

  deleteAccount(profileId: string, id: string) {
    if (!this.store.deleteAccount(profileId, id)) throw new PlanningError('Аккаунт не найден', 404)
    return { deleted: true }
  }
  async refreshCalendars(profileId: string, id: string) {
    const account = this.accountRecord(profileId, id)
    this.store.upsertCalendars(account, await this.clientFor(account).listCalendars())
    return this.store.accounts(profileId).find((item) => item.id === id)!
  }
  updateCalendar(profileId: string, id: string, input: unknown) {
    const { enabled } = calendarPatchSchema.parse(input)
    if (!this.store.setCalendarEnabled(profileId, id, enabled)) throw new PlanningError('Календарь не найден', 404)
    const calendar = this.store.calendarRecord(id)!
    if (enabled) {
      if (calendar.writable && !this.store.settings(profileId).defaultCalendarId) this.store.saveSettings(profileId, { ...this.store.settings(profileId), defaultCalendarId: id })
      const account = this.store.accountRecord(calendar.accountId)
      if (account) void this.sync.syncAccount(account).catch(() => undefined)
    } else this.ensureDefaultCalendar(profileId)
    return this.store.accounts(profileId)
  }

  /**
   * After connecting a calendar the user expects new events to go there. The default is chosen only on
   * connect/enable events, so an explicit «только в этом приложении» choice made later is respected.
   */
  private ensureDefaultCalendar(profileId: string) {
    const settings = this.store.settings(profileId)
    const usable = this.store.calendars(profileId).filter((item) => item.enabled && item.writable)
    if (settings.defaultCalendarId && usable.some((item) => item.id === settings.defaultCalendarId)) return
    if (usable[0]) this.store.saveSettings(profileId, { ...settings, defaultCalendarId: usable[0].id })
  }

  /** Events that live only here and could be sent to a connected calendar. */
  localEvents(profileId: string) {
    return this.store.events(profileId).filter((event) => !event.calendarId && !event.readOnly && !event.recurrenceOf)
  }
  /** Send events created before a calendar was chosen; they are pushed by the next synchronization. */
  moveLocalEvents(profileId: string, calendarId: string) {
    this.writableCalendar(profileId, calendarId)
    const at = this.clock().toISOString()
    const events = this.localEvents(profileId)
    for (const event of events) this.store.saveEvent(profileId, { ...event, calendarId, updatedAt: at })
    this.afterLocalChange(calendarId)
    return { moved: events.length }
  }
  private accountRecord(profileId: string, id: string) {
    const account = this.store.accountRecord(id)
    if (!account || account.profileId !== profileId) throw new PlanningError('Аккаунт не найден', 404)
    return account
  }
  async syncAccount(profileId: string, id: string) {
    try { return await this.sync.syncAccount(this.accountRecord(profileId, id)) } catch (error) {
      if (error instanceof PlanningError) throw error
      throw new PlanningError(error instanceof Error ? error.message : 'Ошибка синхронизации', error instanceof AuthError ? 401 : 502)
    }
  }
  /** Periodic synchronization; failures are stored in the account status instead of being thrown. */
  async syncDue(profileId: string, force = false) {
    // Calendars connected before automatic selection existed get a target on the first tick.
    if (!this.store.hasSettings(profileId)) this.ensureDefaultCalendar(profileId)
    const interval = this.store.settings(profileId).syncIntervalMinutes * 60000
    const now = this.clock().getTime()
    for (const account of this.store.accounts(profileId)) {
      if (account.status === 'needs_auth' && !force) continue
      if (!force && account.lastSyncAt && now - Date.parse(account.lastSyncAt) < interval) continue
      const record = this.store.accountRecord(account.id)
      if (record) await this.sync.syncAccount(record).catch(() => undefined)
    }
  }
  syncLog(profileId: string) { return this.store.syncLog(profileId) }

  // Telegram
  telegramStatus(profileId: string): TelegramStatus {
    const status = this.telegram?.status() ?? { configured: false, managed: false, running: false, botUsername: null, error: 'Telegram не подключён к серверу' }
    return { ...status, chats: this.store.chats(profileId).map(({ profileId: _profile, ...chat }) => chat) }
  }
  async configureTelegram(profileId: string, input: unknown) {
    const { token } = telegramTokenSchema.parse(input)
    if (!this.telegram) throw new PlanningError('Telegram недоступен в этом запуске сервера', 503)
    try { await this.telegram.configure(token) } catch (error) { throw new PlanningError(error instanceof Error ? error.message : 'Не удалось подключить бота', this.telegram.managed ? 409 : 400) }
    return this.telegramStatus(profileId)
  }
  async removeTelegram(profileId: string) {
    try { await this.telegram?.remove() } catch (error) { throw new PlanningError(error instanceof Error ? error.message : 'Не удалось отключить бота', 409) }
    for (const chat of this.store.chats()) this.store.unlinkChat(chat.chatId)
    return this.telegramStatus(profileId)
  }
  telegramLink(profileId: string): TelegramLink {
    if (!this.telegram?.active) throw new PlanningError('Сначала подключите бота и дождитесь статуса «работает»', 409)
    const { code, expiresAt } = this.store.createLinkCode(profileId)
    const username = this.telegram.botUsername
    return { code, url: username ? `https://t.me/${username}?start=${code}` : null, expiresAt }
  }
  unlinkChat(profileId: string, chatId: string) {
    if (this.store.chatProfile(chatId) !== profileId) throw new PlanningError('Чат не найден', 404)
    this.store.unlinkChat(chatId)
    return this.telegramStatus(profileId)
  }
  async sendTest(profileId: string) {
    const chats = this.store.chats(profileId)
    if (!this.telegram?.active || !chats.length) throw new PlanningError('Нет привязанных чатов или бот не запущен', 409)
    for (const chat of chats) await this.telegram.send(chat.chatId, `Проверка связи ✓\n\n${this.brief(profileId).text}`)
    return { sent: chats.length }
  }

  /** Aggregated facts for the trend module: counts only, never titles or notes. */
  moduleFacts(profileId: string) {
    const timeZone = this.store.settings(profileId).timeZone
    const today = this.today(profileId)
    const week = this.occurrences(profileId, dayRange(today, timeZone).start, dayRange(addDays(today, 6), timeZone).end)
    const open = this.store.tasks(profileId).filter((task) => task.status === 'open')
    const overdue = open.filter((task) => task.due && (task.dueHasTime ? Date.parse(task.due) < this.clock().getTime() : task.due < today))
    const projects = new Set(open.map((task) => task.project).filter(Boolean))
    return [`Событий на ближайшие 7 дней: ${week.length}`, `Открытых задач: ${open.length}`, `Просрочено задач: ${overdue.length}`, `Повторяющихся обязательств: ${open.filter((task) => task.rrule).length}`, `Проектов с задачами: ${projects.size}`]
  }
}
