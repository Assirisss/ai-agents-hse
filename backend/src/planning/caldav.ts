import * as cheerio from 'cheerio'
import type { PlanningEvent } from '../../../shared/planning.js'
import { readLimitedText } from '../trends/http.js'
import { buildIcs, parseIcs } from './ical.js'
import { AuthError, PreconditionFailed, type CalendarClient, type RemoteCalendarInfo, type RemoteItem, type SavedRemote } from './sync.js'

export const yandexCalDavUrl = 'https://caldav.yandex.ru/'
const icalStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

type Query = ReturnType<ReturnType<cheerio.CheerioAPI['root']>['find']>
type Response207 = { href: string; props: Query | null }

/**
 * Minimal CalDAV client (RFC 4791) for Yandex Calendar with an app password.
 * All requests stay on the configured origin; hrefs from responses cannot redirect them elsewhere.
 */
export class CalDavClient implements CalendarClient {
  readonly provider = 'yandex'
  readonly editableExceptions = false
  private origin: string
  constructor(private login: string, private password: string, private fallbackTz: string, private baseUrl = yandexCalDavUrl, private fetcher: typeof fetch = fetch, private calendarUrl?: string) {
    this.origin = new URL(baseUrl).origin
  }

  private url(href: string) {
    const url = new URL(href, this.baseUrl)
    if (url.origin !== this.origin) throw new Error('CalDAV вернул адрес за пределами сервера календаря')
    return url
  }

  private async request(method: string, href: string, options: { body?: string; depth?: '0' | '1'; headers?: Record<string, string> } = {}) {
    const response = await this.fetcher(this.url(href), {
      method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      // Identity encoding: Yandex appends «--gzip» to ETags of compressed answers, which breaks comparisons.
      headers: { 'Accept-Encoding': 'identity', Authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString('base64')}`, ...(options.body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}), ...(options.depth ? { Depth: options.depth } : {}), ...options.headers },
      body: options.body,
    })
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new AuthError('Яндекс отклонил логин или пароль приложения') }
    if (response.status === 412) { await response.body?.cancel(); throw new PreconditionFailed('Событие изменилось на сервере') }
    return response
  }

  private async multistatus(method: string, href: string, body: string, depth: '0' | '1'): Promise<Response207[]> {
    const response = await this.request(method, href, { body, depth })
    if (response.status !== 207) { await response.body?.cancel(); throw new Error(`CalDAV ${method} ответил HTTP ${response.status}`) }
    const $ = cheerio.load(await readLimitedText(response, 20_000_000), { xml: true })
    return $.root().find('*').filter((_, node) => local(node) === 'response').toArray().map((node) => {
      const item = $(node)
      const ok = childrenOf(item, 'propstat').toArray().map((propstat) => $(propstat)).find((propstat) => /\s200\s/.test(` ${childrenOf(propstat, 'status').first().text()} `))
      return { href: childrenOf(item, 'href').first().text().trim(), props: ok ? childrenOf(ok, 'prop').first() : null }
    })
  }

  /** current-user-principal → calendar-home-set → calendars supporting VEVENT. */
  async listCalendars(): Promise<RemoteCalendarInfo[]> {
    if (this.calendarUrl) {
      const href = canonicalPath(this.url(this.calendarUrl).pathname.replace(/\/?$/, '/'))
      const [item] = await this.multistatus('PROPFIND', href, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><a:calendar-color/></d:prop></d:propfind>', '0')
      if (!item) throw new Error('Календарь по ссылке не найден')
      return [{ remoteId: href, name: item.props?.find('*').filter((_, node) => local(node) === 'displayname').first().text().trim() || 'Календарь Яндекса', color: colorOf(item.props), writable: true, primary: true }]
    }
    const [principal] = await this.multistatus('PROPFIND', this.baseUrl, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', '0')
    const principalHref = principal?.props?.find('*').filter((_, node) => local(node) === 'href').first().text().trim()
    if (!principalHref) throw new Error('Сервер не сообщил адрес пользователя CalDAV')
    const [home] = await this.multistatus('PROPFIND', principalHref, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>', '0')
    const homeHref = home?.props?.find('*').filter((_, node) => local(node) === 'href').first().text().trim()
    if (!homeHref) throw new Error('Сервер не сообщил адрес календарей')
    const items = await this.multistatus('PROPFIND', homeHref, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/></d:prop></d:propfind>', '1')
    const calendars = items.filter((item) => {
      const props = item.props
      if (!props || !props.find('*').filter((_, node) => local(node) === 'calendar').length) return false
      const components = props.find('*').filter((_, node) => local(node) === 'comp').map((_, node) => String((node as { attribs?: Record<string, string> }).attribs?.name || '').toUpperCase()).get()
      return !components.length || components.includes('VEVENT')
    })
    return calendars.map((item, index) => {
      const privileges = item.props!.find('*').filter((_, node) => local(node) === 'privilege').find('*').map((_, node) => local(node)).get()
      return {
        remoteId: canonicalPath(this.url(item.href).pathname), name: item.props!.find('*').filter((_, node) => local(node) === 'displayname').first().text().trim() || 'Календарь',
        color: colorOf(item.props), writable: !privileges.length || privileges.some((name) => ['write', 'write-content', 'all', 'bind'].includes(name)),
        primary: index === 0 || /events-default/.test(item.href),
      }
    })
  }

  async list(calendarId: string, from: Date, to: Date): Promise<RemoteItem[]> {
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icalStamp(from)}" end="${icalStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
    const items = await this.multistatus('REPORT', calendarId, body, '1')
    return items.flatMap((item) => {
      const etag = item.props?.find('*').filter((_, node) => local(node) === 'getetag').first().text().trim()
      const data = item.props?.find('*').filter((_, node) => local(node) === 'calendar-data').first().text()
      if (!etag || !data) return []
      return [this.item(canonicalPath(this.url(item.href).pathname), etag, data)]
    })
  }

  private item(href: string, etag: string, raw: string): RemoteItem {
    const { master, exceptions } = parseIcs(raw, this.fallbackTz)
    return { remoteId: href, etag, updated: master?.updated ?? null, deleted: !master || master.cancelled, master, exceptions, parentRemoteId: null, raw }
  }

  async get(_calendarId: string, remoteId: string) {
    const response = await this.request('GET', remoteId)
    if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return null }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`CalDAV GET ответил HTTP ${response.status}`) }
    const raw = await readLimitedText(response, 2_000_000)
    return this.item(remoteId, response.headers.get('etag') || '', raw)
  }

  private async saved(remoteId: string, response: Response, raw: string): Promise<SavedRemote> {
    await response.body?.cancel()
    let etag = response.headers.get('etag')
    // Some servers omit ETag after PUT; read it back so the next sync does not see a false change.
    if (!etag) etag = (await this.get('', remoteId))?.etag || ''
    return { remoteId, etag, updated: new Date().toISOString(), raw }
  }

  /** Find a resource by its UID: servers may store it under another name than the one used in PUT. */
  private async findByUid(calendarId: string, uid: string) {
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${uid.replace(/[<>&]/g, '')}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
    const [item] = await this.multistatus('REPORT', calendarId, body, '1')
    if (!item) return null
    return { remoteId: canonicalPath(this.url(item.href).pathname), etag: item.props?.find('*').filter((_, node) => local(node) === 'getetag').first().text().trim() || '' }
  }

  async create(calendarId: string, event: PlanningEvent) {
    const uid = `${event.id}@ai-agents-hse`
    // Yandex stores events as «<UID>.ics» whatever name was used, so the name is the UID from the start.
    const target = canonicalPath(`${this.url(calendarId).pathname.replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`)
    const raw = buildIcs(event, uid, null)
    const response = await this.request('PUT', target, { body: raw, headers: { 'If-None-Match': '*' } })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Не удалось создать событие: HTTP ${response.status}`)
    const location = response.headers.get('location')
    let remoteId = location ? canonicalPath(this.url(location).pathname) : target
    let etag = response.headers.get('etag') || ''
    if (!etag) {
      const stored = await this.get('', remoteId)
      if (stored) etag = stored.etag
      else {
        const found = await this.findByUid(calendarId, uid)
        if (!found) throw new Error('Сервер принял событие, но не показывает его в календаре')
        remoteId = found.remoteId
        etag = found.etag
      }
    }
    return { remoteId, etag, updated: new Date().toISOString(), raw }
  }

  async update(_calendarId: string, remoteId: string, etag: string, event: PlanningEvent, raw: string | null) {
    const body = buildIcs(event, `${event.id}@ai-agents-hse`, raw)
    const response = await this.request('PUT', remoteId, { body, headers: etag ? { 'If-Match': etag } : {} })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Не удалось обновить событие: HTTP ${response.status}`) }
    return this.saved(remoteId, response, body)
  }

  async remove(_calendarId: string, remoteId: string, etag: string) {
    const response = await this.request('DELETE', remoteId, { headers: etag ? { 'If-Match': etag } : {} })
    await response.body?.cancel()
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Не удалось удалить событие: HTTP ${response.status}`)
  }
}

/** One spelling per path: `%40` and `@` name the same resource, so both are compared as `%40`. */
export function canonicalPath(path: string) {
  return path.split('/').map((segment) => { try { return encodeURIComponent(decodeURIComponent(segment)) } catch { return segment } }).join('/')
}
/** Namespace prefixes differ between servers (d:, D:, none), so elements are matched by local name. */
const local = (node: unknown) => { const name = (node as { name?: unknown }).name; return typeof name === 'string' ? name.split(':').pop()!.toLowerCase() : '' }
const childrenOf = (query: Query, name: string) => query.children().filter((_, node) => local(node) === name)
function colorOf(props: Query | null) {
  const value = props?.find('*').filter((_, node) => local(node) === 'calendar-color').first().text().trim() || ''
  return /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : '#0a84ff'
}
