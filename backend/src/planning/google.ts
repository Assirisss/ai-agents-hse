import { z } from 'zod'
import type { PlanningEvent } from '../../../shared/planning.js'
import { readLimitedText } from '../trends/http.js'
import { readRecurrenceLines, recurrenceLines, type RemoteEventData } from './ical.js'
import { AuthError, PreconditionFailed, type CalendarClient, type RemoteCalendarInfo, type RemoteItem, type SavedRemote } from './sync.js'

export type GoogleClientConfig = { clientId: string; clientSecret: string }
export type GoogleTokens = { refreshToken: string; accessToken: string | null; expiresAt: number; email: string }

const scopes = ['https://www.googleapis.com/auth/calendar', 'openid', 'email']
const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number(), refresh_token: z.string().optional(), id_token: z.string().optional() })

/** OAuth 2.0 authorization code flow for a web client; the secret never reaches the browser. */
export class GoogleOAuth {
  constructor(private config: GoogleClientConfig, readonly redirectUri: string, private fetcher: typeof fetch = fetch) {}

  authUrl(state: string) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })) url.searchParams.set(key, value)
    return url.toString()
  }

  private async token(params: Record<string, string>) {
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...params }),
    })
    const text = await readLimitedText(response, 64000)
    if (!response.ok) {
      const error = (() => { try { return String(JSON.parse(text).error || '') } catch { return '' } })()
      if (error === 'invalid_grant') throw new AuthError('Google отозвал доступ или срок действия входа истёк — подключите аккаунт заново')
      if (error === 'invalid_client') throw new Error('Google не принял Client ID или Client Secret')
      throw new Error(`Google OAuth ответил HTTP ${response.status}${error ? ` (${error})` : ''}`)
    }
    return tokenSchema.parse(JSON.parse(text))
  }

  async exchange(code: string): Promise<GoogleTokens> {
    const data = await this.token({ code, redirect_uri: this.redirectUri, grant_type: 'authorization_code' })
    if (!data.refresh_token) throw new Error('Google не выдал refresh token. Отзовите доступ приложения в аккаунте Google и подключитесь снова.')
    // The ID token comes straight from Google over TLS; we only read the e-mail for the account label.
    const payload = data.id_token ? JSON.parse(Buffer.from(data.id_token.split('.')[1] || '', 'base64url').toString('utf8') || '{}') as { email?: string } : {}
    return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, email: payload.email || 'Google' }
  }

  async refresh(tokens: GoogleTokens): Promise<GoogleTokens> {
    const data = await this.token({ refresh_token: tokens.refreshToken, grant_type: 'refresh_token' })
    return { ...tokens, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, refreshToken: data.refresh_token || tokens.refreshToken }
  }
}

const timeSchema = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }).passthrough()
const eventSchema = z.object({
  id: z.string(), etag: z.string().default(''), status: z.string().default('confirmed'), updated: z.string().optional(),
  summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(),
  start: timeSchema.optional(), end: timeSchema.optional(), recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(), originalStartTime: timeSchema.optional(),
}).passthrough()
type GoogleEvent = z.infer<typeof eventSchema>

export class GoogleCalendarClient implements CalendarClient {
  readonly provider = 'google'
  readonly editableExceptions = true
  constructor(private oauth: GoogleOAuth, private tokens: GoogleTokens, private onTokens: (tokens: GoogleTokens) => void, private fallbackTz: string, private fetcher: typeof fetch = fetch) {}

  private async accessToken(force = false) {
    if (force || !this.tokens.accessToken || this.tokens.expiresAt < Date.now() + 60000) {
      this.tokens = await this.oauth.refresh(this.tokens)
      this.onTokens(this.tokens)
    }
    return this.tokens.accessToken!
  }

  private async api(method: string, path: string, options: { query?: Record<string, string>; body?: unknown; etag?: string } = {}, retried = false): Promise<{ status: number; data: unknown }> {
    const url = new URL(`https://www.googleapis.com/calendar/v3${path}`)
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value)
    const response = await this.fetcher(url, {
      method, signal: AbortSignal.timeout(30000), body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: { Authorization: `Bearer ${await this.accessToken(retried)}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.etag ? { 'If-Match': options.etag } : {}) },
    })
    if (response.status === 401 && !retried) { await response.body?.cancel(); return this.api(method, path, options, true) }
    if (response.status === 401) { await response.body?.cancel(); throw new AuthError('Google отклонил доступ — подключите аккаунт заново') }
    if (response.status === 412) { await response.body?.cancel(); throw new PreconditionFailed('Событие изменилось в Google Календаре') }
    if (response.status === 404 || response.status === 410 || response.status === 204) { await response.body?.cancel(); return { status: response.status, data: null } }
    const text = await readLimitedText(response, 10_000_000)
    if (!response.ok) {
      const message = (() => { try { return String(JSON.parse(text).error?.message || '') } catch { return '' } })()
      throw new Error(`Google Calendar ответил HTTP ${response.status}${message ? `: ${message.slice(0, 200)}` : ''}`)
    }
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }

  async listCalendars(): Promise<RemoteCalendarInfo[]> {
    const { data } = await this.api('GET', '/users/me/calendarList', { query: { minAccessRole: 'reader', maxResults: '250' } })
    const items = z.object({ items: z.array(z.object({ id: z.string(), summary: z.string().optional(), summaryOverride: z.string().optional(), backgroundColor: z.string().optional(), accessRole: z.string(), primary: z.boolean().optional() }).passthrough()).default([]) }).parse(data).items
    return items.map((item) => ({ remoteId: item.id, name: item.summaryOverride || item.summary || item.id, color: item.backgroundColor || '#0a84ff', writable: ['owner', 'writer'].includes(item.accessRole), primary: Boolean(item.primary) }))
  }

  private time(value: z.infer<typeof timeSchema> | undefined) {
    if (value?.date) return { value: value.date, allDay: true }
    if (value?.dateTime) return { value: new Date(value.dateTime).toISOString(), allDay: false }
    return null
  }

  private toItem(event: GoogleEvent, calendarZone: string): RemoteItem {
    const zone = event.start?.timeZone || calendarZone
    const start = this.time(event.start)
    const end = this.time(event.end)
    const original = this.time(event.originalStartTime)
    const cancelled = event.status === 'cancelled'
    // A cancelled occurrence of a series is an exception that hides it, not a deleted object.
    if (cancelled && !event.recurringEventId) return { remoteId: event.id, etag: event.etag, updated: event.updated ?? null, deleted: true, master: null, exceptions: [], parentRemoteId: null, raw: null }
    const recurrence = readRecurrenceLines(event.recurrence || [], zone)
    const fallbackStart = start ?? original
    if (!fallbackStart) return { remoteId: event.id, etag: event.etag, updated: event.updated ?? null, deleted: true, master: null, exceptions: [], parentRemoteId: null, raw: null }
    const master: RemoteEventData = {
      uid: event.id, title: event.summary?.trim() || 'Без названия', description: event.description || '', location: event.location || '',
      allDay: fallbackStart.allDay, start: fallbackStart.value, end: end?.value || fallbackStart.value, timeZone: zone,
      rrule: recurrence.rrule, exdates: recurrence.exdates, recurrenceId: event.recurringEventId ? original?.value ?? fallbackStart.value : null,
      cancelled, updated: event.updated ?? null,
    }
    return { remoteId: event.id, etag: event.etag, updated: event.updated ?? null, deleted: false, master, exceptions: [], parentRemoteId: event.recurringEventId ?? null, raw: null }
  }

  async list(calendarId: string, from: Date, to: Date): Promise<RemoteItem[]> {
    const items: RemoteItem[] = []
    let pageToken = ''
    for (let page = 0; page < 40; page++) {
      const { data } = await this.api('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, { query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'false', showDeleted: 'true', maxResults: '250', ...(pageToken ? { pageToken } : {}) } })
      const parsed = z.object({ items: z.array(eventSchema).default([]), nextPageToken: z.string().optional(), timeZone: z.string().optional() }).parse(data)
      items.push(...parsed.items.map((item) => this.toItem(item, parsed.timeZone || this.fallbackTz)))
      if (!parsed.nextPageToken) break
      pageToken = parsed.nextPageToken
    }
    return items
  }

  async get(calendarId: string, remoteId: string) {
    const { data } = await this.api('GET', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`)
    return data ? this.toItem(eventSchema.parse(data), this.fallbackTz) : null
  }

  private body(event: PlanningEvent) {
    const time = (value: string) => event.allDay ? { date: value, dateTime: null, timeZone: null } : { dateTime: value, timeZone: event.timeZone, date: null }
    return {
      summary: event.title, description: event.description, location: event.location, start: time(event.start), end: time(event.end),
      ...(event.recurrenceOf ? {} : { recurrence: recurrenceLines(event) }),
    }
  }

  private saved(data: unknown): SavedRemote {
    const event = eventSchema.parse(data)
    return { remoteId: event.id, etag: event.etag, updated: event.updated ?? null, raw: null }
  }

  async create(calendarId: string, event: PlanningEvent) {
    const { data } = await this.api('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, { body: this.body(event) })
    return this.saved(data)
  }

  async update(calendarId: string, remoteId: string, etag: string, event: PlanningEvent) {
    const { data } = await this.api('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`, { body: this.body(event), etag })
    if (!data) throw new PreconditionFailed('Событие удалено в Google Календаре')
    return this.saved(data)
  }

  async remove(calendarId: string, remoteId: string, etag: string) {
    await this.api('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`, { etag })
  }
}
