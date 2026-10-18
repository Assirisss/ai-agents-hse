import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlanningEvent } from '../../../shared/planning.js'
import { createApp } from '../app.js'
import { TrendResearchService } from '../trends/service.js'
import { parseItem, splitRequests, type ParseContext } from '../planning/dateparse.js'
import { expandEvents, nextOccurrence } from '../planning/recurrence.js'
import { dayBrief } from '../planning/agenda.js'
import { DraftExtractor, quotedFrom } from '../planning/extract.js'
import type { JsonModel } from '../planning/model.js'
import { buildIcs, parseIcs, readRecurrenceLines, recurrenceLines, type RemoteEventData } from '../planning/ical.js'
import { PlanningStore } from '../planning/store.js'
import { SecretBox } from '../planning/secrets.js'
import { PlanningService } from '../planning/service.js'
import { PreconditionFailed, SyncEngine, type CalendarClient, type RemoteItem } from '../planning/sync.js'
import { CalDavClient } from '../planning/caldav.js'
import { GoogleCalendarClient, GoogleOAuth } from '../planning/google.js'
import { defaultSettings } from '../planning/schema.js'
import { dueNotifications, PlanningScheduler } from '../planning/scheduler.js'
import { registerPlanningCommands } from '../planning/telegram.js'
import { TelegramService } from '../telegram/service.js'
import { TelegramBot } from '../telegram/bot.js'
import { createPlanningTools } from '../planning/tool.js'
import { answerRequest, dispatch } from '../planning/agent.js'
import type { ChatMessage, ToolModel, ToolSpec } from '../planning/model.js'

// Monday, 19 October 2026, 09:00 in Moscow.
const monday = new Date('2026-10-19T06:00:00.000Z')
const context: ParseContext = { now: monday, timeZone: 'Europe/Moscow' }
const box = SecretBox.ephemeral()

function setup(options: { now?: Date; extractor?: DraftExtractor; fetcher?: typeof fetch; telegram?: TelegramService; agentModel?: ToolModel } = {}) {
  let current = options.now ?? monday
  const clock = () => current
  const store = new PlanningStore(':memory:', box, clock)
  const service = new PlanningService(store, options.extractor ?? new DraftExtractor(), { clock, fetcher: options.fetcher, telegram: options.telegram, agentModel: options.agentModel })
  return { store, service, clock, setNow: (value: Date) => { current = value } }
}

const event = (patch: Partial<PlanningEvent>): PlanningEvent => ({
  id: 'e1', title: 'Событие', description: '', location: '', allDay: false, start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T08:00:00.000Z',
  timeZone: 'Europe/Moscow', rrule: null, exdates: [], reminderMinutes: null, calendarId: null, source: 'manual', readOnly: false,
  recurrenceOf: null, recurrenceId: null, cancelled: false, createdAt: monday.toISOString(), updatedAt: monday.toISOString(), ...patch,
})

void test('Russian parser covers typical phrases and reports assumptions', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['завтра в 15 созвон с бухгалтером', { kind: 'event', title: 'Созвон с бухгалтером', start: '2026-10-20T12:00:00.000Z', end: '2026-10-20T13:00:00.000Z' }],
    ['встреча с Петей в пятницу с 14 до 16', { kind: 'event', title: 'Встреча с Петей', start: '2026-10-23T11:00:00.000Z', end: '2026-10-23T13:00:00.000Z' }],
    ['оплатить аренду до 25-го', { kind: 'task', title: 'Оплатить аренду', due: '2026-10-25', dueHasTime: false }],
    ['сдать отчёт к пятнице до 18:00', { kind: 'task', title: 'Сдать отчёт', due: '2026-10-23T15:00:00.000Z', dueHasTime: true }],
    ['напомни завтра в 10 позвонить маме', { kind: 'task', title: 'Позвонить маме', due: '2026-10-20T07:00:00.000Z', reminderMinutes: 0 }],
    ['каждый понедельник в 9:30 планёрка', { kind: 'event', title: 'Планёрка', rrule: 'FREQ=WEEKLY;BYDAY=MO', start: '2026-10-19T06:30:00.000Z' }],
    ['тренировка по вторникам и четвергам в 7 вечера на полтора часа', { kind: 'event', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', start: '2026-10-20T16:00:00.000Z', end: '2026-10-20T17:30:00.000Z' }],
    ['день рождения Ани 3 ноября', { kind: 'event', allDay: true, start: '2026-11-03', end: '2026-11-04' }],
    ['каждое 10 число оплатить налог УСН', { kind: 'task', title: 'Оплатить налог УСН', due: '2026-11-10', rrule: 'FREQ=MONTHLY;BYMONTHDAY=10' }],
    ['стоматолог 21.10 в 9 утра', { kind: 'event', title: 'Стоматолог', start: '2026-10-21T06:00:00.000Z' }],
    ['купить молоко', { kind: 'task', title: 'Купить молоко', due: null }],
    ['сдать курсовую до конца месяца', { kind: 'task', due: '2026-10-31' }],
    ['созвон в следующую среду в 11', { kind: 'event', start: '2026-10-28T08:00:00.000Z' }],
    ['созвон в 10.11', { kind: 'event', start: '2026-10-19T07:11:00.000Z' }],
    ['отпуск на 10.11', { kind: 'event', allDay: true, start: '2026-11-10' }],
  ]
  for (const [text, expected] of cases) {
    const item = parseItem(text, context)
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(item[key as keyof typeof item], value, `${text}: ${key}`)
  }
  assert.ok(parseItem('созвон в 3', context).assumptions.some((value) => value.includes('15:00')))
  // Monday 09:00: an event «в понедельник в 8» already passed today, so it moves a week ahead.
  assert.equal(parseItem('встреча в понедельник в 8 утра', context).start, '2026-10-26T05:00:00.000Z')
  assert.deepEqual(parseItem('встреча на следующей неделе', context).missing, ['день («на следующей неделе» — какой именно?)', 'время'])
  assert.equal(parseItem('встреча завтра и в пятницу', context).compound, true)
  assert.deepEqual(splitRequests('в пятницу в 15 созвон, а до 25-го сдать отчёт\nкупить хлеб'), ['в пятницу в 15 созвон', 'до 25-го сдать отчёт', 'купить хлеб'])
})

void test('recurrence keeps wall-clock time across DST and respects exceptions', () => {
  // Berlin switches from CEST to CET on 25 October 2026.
  const series = event({ timeZone: 'Europe/Berlin', start: '2026-10-19T08:00:00.000Z', end: '2026-10-19T09:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: ['2026-11-02T09:00:00.000Z'] })
  const moved = event({ id: 'e2', title: 'Перенос', recurrenceOf: 'e1', recurrenceId: '2026-11-09T09:00:00.000Z', start: '2026-11-09T12:00:00.000Z', end: '2026-11-09T13:00:00.000Z' })
  const items = expandEvents([series, moved], new Date('2026-10-18T00:00:00Z'), new Date('2026-11-17T00:00:00Z'), 'Europe/Moscow')
  assert.deepEqual(items.map((item) => [item.title, item.start]), [
    ['Событие', '2026-10-19T08:00:00.000Z'], ['Событие', '2026-10-26T09:00:00.000Z'], ['Перенос', '2026-11-09T12:00:00.000Z'], ['Событие', '2026-11-16T09:00:00.000Z'],
  ])
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=10', '2026-11-10', 'Europe/Moscow'), '2026-12-10')
  const until = event({ rrule: 'FREQ=DAILY;UNTIL=20261021T070000Z' })
  assert.equal(expandEvents([until], new Date('2026-10-18T00:00:00Z'), new Date('2026-10-30T00:00:00Z'), 'Europe/Moscow').length, 3)
})

void test('daily brief finds conflicts, free windows, overdue tasks and overload without a model', () => {
  const events = [
    event({ id: 'a', title: 'Планёрка', start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T08:00:00.000Z' }),
    event({ id: 'b', title: 'Созвон', start: '2026-10-19T07:30:00.000Z', end: '2026-10-19T09:00:00.000Z' }),
    event({ id: 'c', title: 'Праздник', allDay: true, start: '2026-10-19', end: '2026-10-20' }),
  ]
  const task = (id: string, due: string | null, patch = {}) => ({ id, title: `Задача ${id}`, notes: '', project: '', due, dueHasTime: Boolean(due?.includes('T')), durationMinutes: 240, priority: 2 as const, status: 'open' as const, completedAt: null, reminderMinutes: null, rrule: null, source: 'manual' as const, createdAt: '', updatedAt: '', ...patch })
  const brief = dayBrief(events, [task('t1', '2026-10-19'), task('t2', '2026-10-17'), task('t3', '2026-10-19T15:00:00.000Z')], '2026-10-19', defaultSettings, monday)
  assert.equal(brief.events.length, 2)
  assert.equal(brief.allDay.length, 1)
  assert.equal(brief.conflicts.length, 1)
  assert.equal(brief.conflicts[0].overlapMinutes, 30)
  assert.deepEqual(brief.freeSlots.map((slot) => [slot.start, slot.minutes]), [['2026-10-19T06:00:00.000Z', 60], ['2026-10-19T09:00:00.000Z', 420]])
  assert.equal(brief.freeMinutes, 480)
  assert.deepEqual(brief.tasksDue.map((item) => item.id), ['t3', 't1'])
  assert.deepEqual(brief.overdue.map((item) => item.id), ['t2'])
  assert.equal(brief.plannedTaskMinutes, 720)
  assert.equal(brief.overload, true)
  assert.match(brief.text, /Пересечения/)
  assert.match(brief.text, /часть стоит перенести/)
})

void test('completing a repeating obligation creates the next one', () => {
  const { service } = setup()
  const task = service.createTask('default', { title: 'НДФЛ за сотрудников', due: '2026-10-28', rrule: 'FREQ=MONTHLY;BYMONTHDAY=28' })
  const result = service.completeTask('default', task.id)
  assert.equal(result.task.status, 'done')
  assert.equal(result.next?.due, '2026-11-28')
  assert.equal(result.next?.status, 'open')
  assert.throws(() => service.createTask('default', { title: 'Без срока', rrule: 'FREQ=DAILY' }), /первый срок/)
})

class FakeModel implements JsonModel {
  readonly provider = 'ollama'
  readonly model = 'fake'
  calls = 0
  constructor(private answer: unknown | Error) {}
  async complete() { this.calls++; if (this.answer instanceof Error) throw this.answer; return this.answer }
}

void test('model is called only for a concrete reason, dates are computed by rules, invented phrases are dropped', async () => {
  const model = new FakeModel({ items: [
    { kind: 'event', title: 'Встреча с Олей', when: 'завтра', deadline: '', duration: '', repeat: '' },
    { kind: 'event', title: 'Созвон с банком', when: 'в пятницу в 11', deadline: '', duration: '', repeat: '' },
    { kind: 'task', title: 'Придумано', when: 'в субботу в 10', deadline: '', duration: '', repeat: '' },
  ], question: 'Во сколько встреча с Олей?' })
  const extractor = new DraftExtractor(model)
  const simple = await extractor.extract('завтра в 15 созвон', context)
  assert.equal(simple.method, 'parser')
  assert.equal(model.calls, 0)
  const result = await extractor.extract('встреча завтра с Олей и созвон с банком в пятницу в 11', context)
  assert.equal(model.calls, 1)
  assert.equal(result.method, 'ai')
  assert.equal(result.items[1].start, '2026-10-23T08:00:00.000Z')
  assert.deepEqual(result.items[0].missing, ['время'])
  assert.equal(result.question, 'Во сколько встреча с Олей?')
  assert.equal(result.items[2].due, null)
  assert.ok(result.notes.some((note) => note.includes('нет в сообщении')))
  assert.equal(quotedFrom('в пятницу в 11', 'созвон в пятницу в 11'), true)
  assert.equal(quotedFrom('в субботу', 'созвон в пятницу'), false)
  const failing = await new DraftExtractor(new FakeModel(new Error('offline'))).extract('встреча завтра и в пятницу', context)
  assert.equal(failing.method, 'parser')
  assert.ok(failing.notes.some((note) => note.includes('оставлен результат правил')))
  const disabled = await new DraftExtractor().extract('как-нибудь на днях к врачу', context)
  assert.ok(disabled.notes.some((note) => note.includes('Модель не настроена')))
})

const yandexIcs = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Yandex LLC//Yandex Calendar//EN',
  'BEGIN:VEVENT', 'UID:abc@yandex.ru', 'DTSTART;TZID=Europe/Moscow:20261019T100000', 'DTEND;TZID=Europe/Moscow:20261019T110000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Moscow:20261026T100000', 'SUMMARY:Планёрка', 'X-YANDEX-CUSTOM:keep-me',
  'ATTENDEE;CN=Petya:mailto:p@example.com', 'LAST-MODIFIED:20261010T120000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:abc@yandex.ru', 'RECURRENCE-ID;TZID=Europe/Moscow:20261102T100000', 'DTSTART;TZID=Europe/Moscow:20261102T120000',
  'DTEND;TZID=Europe/Moscow:20261102T130000', 'SUMMARY:Планёрка (перенос)', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n')

void test('iCalendar: parse series with exceptions, update only master fields, keep foreign properties', () => {
  const { master, exceptions } = parseIcs(yandexIcs, 'UTC')
  assert.equal(master?.start, '2026-10-19T07:00:00.000Z')
  assert.equal(master?.timeZone, 'Europe/Moscow')
  assert.equal(master?.rrule, 'FREQ=WEEKLY;BYDAY=MO')
  assert.deepEqual(master?.exdates, ['2026-10-26T07:00:00.000Z'])
  assert.equal(exceptions[0].recurrenceId, '2026-11-02T07:00:00.000Z')
  const updated = buildIcs(event({ title: 'Планёрка команды', start: master!.start, end: master!.end, rrule: master!.rrule, exdates: master!.exdates }), 'abc@yandex.ru', yandexIcs)
  assert.match(updated, /SUMMARY:Планёрка команды/)
  assert.match(updated, /X-YANDEX-CUSTOM:keep-me/)
  assert.match(updated, /ATTENDEE;CN=Petya/)
  assert.match(updated, /RECURRENCE-ID;TZID=Europe\/Moscow:20261102T100000/)
  assert.match(updated, /DTSTART;TZID=Europe\/Moscow:20261019T100000/)
  assert.equal(parseIcs(updated, 'UTC').master?.title, 'Планёрка команды')
  const allDay = parseIcs(buildIcs(event({ allDay: true, start: '2026-11-03', end: '2026-11-04' }), 'x', null), 'Europe/Moscow').master
  assert.deepEqual([allDay?.allDay, allDay?.start, allDay?.end], [true, '2026-11-03', '2026-11-04'])
  const lines = recurrenceLines(event({ rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: ['2026-10-26T07:00:00.000Z'] }))
  assert.deepEqual(readRecurrenceLines(lines, 'Europe/Moscow'), { rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: ['2026-10-26T07:00:00.000Z'] })
})

/** In-memory remote calendar with ETags, for the synchronization algorithm. */
class FakeRemote implements CalendarClient {
  readonly provider = 'google'
  readonly editableExceptions = true
  items = new Map<string, { data: RemoteEventData; etag: string; updated: string }>()
  hidden = new Set<string>()
  private counter = 0
  constructor(private clock: () => Date) {}
  private item(id: string): RemoteItem {
    const value = this.items.get(id)!
    return { remoteId: id, etag: value.etag, updated: value.updated, deleted: false, master: value.data, exceptions: [], parentRemoteId: null, raw: null }
  }
  async listCalendars() { return [{ remoteId: 'cal', name: 'Работа', color: '#0a84ff', writable: true, primary: true }] }
  async list() { return [...this.items.keys()].filter((id) => !this.hidden.has(id)).map((id) => this.item(id)) }
  async get(_calendar: string, id: string) { return this.items.has(id) ? this.item(id) : null }
  private data(event: PlanningEvent): RemoteEventData { return { uid: event.id, title: event.title, description: event.description, location: event.location, allDay: event.allDay, start: event.start, end: event.end, timeZone: event.timeZone, rrule: event.rrule, exdates: event.exdates, recurrenceId: null, cancelled: false, updated: null } }
  async create(_calendar: string, event: PlanningEvent) {
    const id = `r${++this.counter}`
    this.items.set(id, { data: this.data(event), etag: `etag-${this.counter}`, updated: this.clock().toISOString() })
    return { remoteId: id, etag: `etag-${this.counter}`, updated: this.clock().toISOString(), raw: null }
  }
  async update(_calendar: string, id: string, etag: string, event: PlanningEvent) {
    const value = this.items.get(id)
    if (!value || value.etag !== etag) throw new PreconditionFailed('changed')
    const next = `etag-${++this.counter}`
    this.items.set(id, { data: this.data(event), etag: next, updated: this.clock().toISOString() })
    return { remoteId: id, etag: next, updated: this.clock().toISOString(), raw: null }
  }
  async remove(_calendar: string, id: string) { this.items.delete(id) }
  edit(id: string, title: string, updated: string) {
    const value = this.items.get(id)!
    this.items.set(id, { data: { ...value.data, title }, etag: `etag-${++this.counter}`, updated })
  }
}

void test('two-way sync: import, push, remote edit, conflicts, deletions in both directions', async () => {
  const { store, service, setNow, clock } = setup()
  const remote = new FakeRemote(clock)
  const engine = new SyncEngine(store, () => remote, clock)
  const account = store.saveAccount('default', 'google', 'me@example.com', { refreshToken: 'x' })
  const [calendar] = store.upsertCalendars(account, await remote.listCalendars())
  remote.items.set('g1', { data: { uid: 'g1', title: 'Из Google', description: '', location: 'Офис', allDay: false, start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z', timeZone: 'Europe/Moscow', rrule: null, exdates: [], recurrenceId: null, cancelled: false, updated: null }, etag: 'etag-g1', updated: '2026-10-18T00:00:00.000Z' })

  const local = store.saveEvent('default', event({ id: 'local-1', title: 'Создано здесь', calendarId: calendar.id }))
  let [report] = await engine.syncAccount(account)
  assert.deepEqual([report.pulled.created, report.pushed.created], [1, 1])
  const imported = store.events('default').find((item) => item.title === 'Из Google')!
  assert.equal(imported.source, 'google')
  assert.equal([...remote.items.values()].some((item) => item.data.title === 'Создано здесь'), true)

  // Nothing changed: no traffic in either direction.
  ;[report] = await engine.syncAccount(account)
  assert.deepEqual([report.pulled, report.pushed], [{ created: 0, updated: 0, deleted: 0 }, { created: 0, updated: 0, deleted: 0 }])

  // Remote edit is pulled; local edit is pushed.
  remote.edit('g1', 'Из Google (изменено)', '2026-10-19T06:10:00.000Z')
  setNow(new Date('2026-10-19T06:20:00.000Z'))
  service.updateEvent('default', local.id, { title: 'Создано здесь (изменено)' })
  ;[report] = await engine.syncAccount(account)
  assert.deepEqual([report.pulled.updated, report.pushed.updated], [1, 1])
  assert.equal(store.event('default', imported.id)?.title, 'Из Google (изменено)')
  assert.ok([...remote.items.values()].some((item) => item.data.title === 'Создано здесь (изменено)'))

  // Conflict: both changed, the later change wins and is reported.
  setNow(new Date('2026-10-19T07:00:00.000Z'))
  service.updateEvent('default', imported.id, { title: 'Правка здесь' })
  remote.edit('g1', 'Правка в Google', '2026-10-19T07:30:00.000Z')
  setNow(new Date('2026-10-19T08:00:00.000Z'))
  ;[report] = await engine.syncAccount(account)
  assert.equal(report.conflicts[0]?.kept, 'remote')
  assert.equal(store.event('default', imported.id)?.title, 'Правка в Google')

  // Event outside the answer is checked directly and only then treated as deleted.
  remote.hidden.add('g1')
  ;[report] = await engine.syncAccount(account)
  assert.ok(store.event('default', imported.id))
  remote.items.delete('g1')
  ;[report] = await engine.syncAccount(account)
  assert.equal(report.pulled.deleted, 1)
  assert.equal(store.event('default', imported.id), null)

  // Local deletion is pushed and the tombstone disappears.
  service.deleteEvent('default', local.id)
  ;[report] = await engine.syncAccount(account)
  assert.equal(report.pushed.deleted, 1)
  assert.equal(remote.items.size, 0)
  assert.equal(store.eventRow('default', local.id), null)

  // Turning a calendar off removes imported copies but keeps events created here.
  remote.items.set('g2', { data: { ...remote.items.get('g1')?.data ?? { uid: 'g2', title: 'Ещё', description: '', location: '', allDay: true, start: '2026-10-21', end: '2026-10-22', timeZone: 'Europe/Moscow', rrule: null, exdates: [], recurrenceId: null, cancelled: false, updated: null } }, etag: 'e', updated: '2026-10-19T08:00:00.000Z' })
  const mine = store.saveEvent('default', event({ id: 'local-2', calendarId: calendar.id }))
  await engine.syncAccount(account)
  store.setCalendarEnabled('default', calendar.id, false)
  assert.deepEqual(store.events('default').map((item) => [item.id, item.calendarId]), [[mine.id, null]])
  service.close()
})

function xmlResponse(body: string, status = 207, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset=utf-8', ...headers } })
}

void test('CalDAV client discovers Yandex calendars with any namespace prefixes and stays on its origin', async () => {
  const requests: { method: string; url: string; headers: Headers; body?: string }[] = []
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    requests.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body as string | undefined })
    if (init.method === 'PROPFIND' && url === 'https://caldav.yandex.ru/') return xmlResponse('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/principals/users/user%40yandex.ru/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>')
    if (init.method === 'PROPFIND' && url.includes('/principals/')) return xmlResponse('<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/principals/users/user%40yandex.ru/</href><propstat><prop><C:calendar-home-set><href>/calendars/user%40yandex.ru/</href></C:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>')
    if (init.method === 'PROPFIND') return xmlResponse(`<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
      <d:response><d:href>/calendars/user%40yandex.ru/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/calendars/user%40yandex.ru/events-default/</d:href><d:propstat><d:prop><d:displayname>Мои события</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set><x:calendar-color>#49a3ffff</x:calendar-color><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/calendars/user%40yandex.ru/todos-default/</d:href><d:propstat><d:prop><d:displayname>Дела</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`)
    if (init.method === 'REPORT') return xmlResponse(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/user%40yandex.ru/events-default/abc.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>${yandexIcs}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
    if (init.method === 'PUT') return new Response(null, { status: 201, headers: { ETag: '"2"' } })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const client = new CalDavClient('user@yandex.ru', 'app-password-123', 'Europe/Moscow', 'https://caldav.yandex.ru/', fetcher)
  const calendars = await client.listCalendars()
  assert.deepEqual(calendars, [{ remoteId: '/calendars/user%40yandex.ru/events-default/', name: 'Мои события', color: '#49a3ff', writable: true, primary: true }])
  assert.equal(requests[0].headers.get('authorization'), `Basic ${Buffer.from('user@yandex.ru:app-password-123').toString('base64')}`)
  const [item] = await client.list(calendars[0].remoteId, new Date('2026-10-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))
  assert.deepEqual([item.etag, item.master?.title, item.exceptions.length], ['"1"', 'Планёрка', 1])
  assert.match(requests.at(-1)!.body!, /time-range start="20261001T000000Z"/)
  const saved = await client.create(calendars[0].remoteId, event({ id: 'new-1' }))
  assert.deepEqual([saved.remoteId, saved.etag], ['/calendars/user%40yandex.ru/events-default/new-1%40ai-agents-hse.ics', '"2"'])
  assert.equal(requests.at(-1)!.headers.get('if-none-match'), '*')
  await assert.rejects(() => client.get('', 'https://evil.example/steal'), /за пределами сервера/)
})

void test('Google client maps events, refreshes tokens and uses ETags for writes', async () => {
  const calls: { url: string; method: string; headers: Headers; body?: string }[] = []
  let tokenRequests = 0
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, method: String(init.method || 'GET'), headers: new Headers(init.headers), body: init.body ? String(init.body) : undefined })
    if (url.startsWith('https://oauth2.googleapis.com/token')) { tokenRequests++; return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 }) }
    if (url.includes('/events?')) return Response.json({ timeZone: 'Europe/Moscow', items: [
      { id: 'a', etag: '"a"', status: 'confirmed', summary: 'Отпуск', start: { date: '2026-11-03' }, end: { date: '2026-11-05' }, updated: '2026-10-01T00:00:00Z' },
      { id: 'b', etag: '"b"', status: 'confirmed', summary: 'Йога', start: { dateTime: '2026-10-20T19:00:00+03:00', timeZone: 'Europe/Moscow' }, end: { dateTime: '2026-10-20T20:00:00+03:00' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=Europe/Moscow:20261027T190000'] },
      { id: 'b_20261103', etag: '"c"', status: 'cancelled', recurringEventId: 'b', originalStartTime: { dateTime: '2026-11-03T19:00:00+03:00' } },
      { id: 'd', etag: '"d"', status: 'cancelled' },
    ] })
    if (init.method === 'PATCH') return new Headers(init.headers).get('if-match') === '"b"' ? Response.json({ id: 'b', etag: '"b2"', updated: '2026-10-19T06:00:00Z' }) : new Response(null, { status: 412 })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  let saved = 0
  const oauth = new GoogleOAuth({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-secret' }, 'http://localhost:5173/api/planning/google/callback', fetcher)
  const client = new GoogleCalendarClient(oauth, { refreshToken: 'refresh', accessToken: null, expiresAt: 0, email: 'me@gmail.com' }, () => { saved++ }, 'UTC', fetcher)
  const items = await client.list('primary', new Date('2026-10-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))
  assert.equal(saved, 1)
  assert.equal(calls.find((call) => call.url.includes('/events?'))?.headers.get('authorization'), 'Bearer token-1')
  assert.deepEqual([items[0].master?.allDay, items[0].master?.start, items[0].master?.end], [true, '2026-11-03', '2026-11-05'])
  assert.deepEqual([items[1].master?.rrule, items[1].master?.exdates, items[1].master?.timeZone], ['FREQ=WEEKLY;BYDAY=TU', ['2026-10-27T16:00:00.000Z'], 'Europe/Moscow'])
  assert.deepEqual([items[2].deleted, items[2].parentRemoteId, items[2].master?.cancelled, items[2].master?.recurrenceId], [false, 'b', true, '2026-11-03T16:00:00.000Z'])
  assert.equal(items[3].deleted, true)
  const updated = await client.update('primary', 'b', '"b"', event({ id: 'local', rrule: 'FREQ=WEEKLY;BYDAY=TU' }))
  assert.equal(updated.etag, '"b2"')
  const body = JSON.parse(calls.at(-1)!.body!)
  assert.deepEqual(body.start, { dateTime: '2026-10-19T07:00:00.000Z', timeZone: 'Europe/Moscow', date: null })
  assert.deepEqual(body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU'])
  await assert.rejects(() => client.update('primary', 'b', '"old"', event({})), PreconditionFailed)
  assert.match(oauth.authUrl('state-1'), /access_type=offline.*state=state-1/)
})

/** Fake Bot API: records sent messages; getUpdates waits briefly and returns nothing. */
function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = []
  let messageId = 0
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(input).split('/').pop()!
    const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
    if (method === 'getUpdates') { await new Promise((resolve) => setTimeout(resolve, 20)); return Response.json({ ok: true, result: [] }) }
    sent.push({ method, body })
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, username: 'plan_test_bot', first_name: 'Test' } })
    if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: ++messageId, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text } })
    return Response.json({ ok: true, result: true })
  }) as typeof fetch
  let token: string | null = null
  const telegram = new TelegramService({ get: () => token, set: (value) => { token = value } }, fetcher)
  return { telegram, sent, bot: new TelegramBot('1:test', fetcher) }
}

void test('Telegram: linking by one-time code, drafts with confirmation, unlinked chats get nothing', async () => {
  const { telegram, sent, bot } = fakeTelegram()
  const { service, store } = setup({ telegram })
  registerPlanningCommands(telegram, service)
  await service.configureTelegram('default', { token: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
  const message = (text: string, chatId = 42) => telegram.router.dispatch(bot, { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private', first_name: 'Миша' }, text } })

  await message('завтра в 15 созвон')
  assert.match(String(sent.at(-1)?.body.text), /не привязан/)
  assert.equal(store.events('default').length, 0)

  const link = service.telegramLink('default')
  assert.equal(link.url, `https://t.me/plan_test_bot?start=${link.code}`)
  await message(`/start ${link.code}`)
  assert.equal(store.chatProfile('42'), 'default')
  await message(`/start ${link.code}`, 43)
  assert.equal(store.chatProfile('43'), null)

  await message('завтра в 15 созвон с бухгалтером')
  const reply = sent.at(-1)!.body
  assert.match(String(reply.text), /Созвон с бухгалтером/)
  const buttons = (reply.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]
  assert.equal(buttons[0].callback_data.startsWith('pl:ok:'), true)
  await telegram.router.dispatch(bot, { update_id: 2, callback_query: { id: 'q', data: buttons[0].callback_data, message: { message_id: 5, chat: { id: 42, type: 'private' } } } })
  assert.deepEqual(store.events('default').map((item) => [item.title, item.source]), [['Созвон с бухгалтером', 'parser']])

  // Missing time: no save button; the next message completes the request.
  await message('встреча с Олей в пятницу')
  assert.match(String(sent.at(-1)?.body.text), /Ответьте следующим сообщением/)
  await message('в 11')
  assert.match(String(sent.at(-1)?.body.text), /11:00–12:00/)

  await message('/tasks')
  assert.match(String(sent.at(-1)?.body.text), /Открытых задач нет/)
  await telegram.stop()
  service.close()
})

void test('scheduler sends the morning plan and reminders once, inside their windows', async () => {
  const { telegram, sent } = fakeTelegram()
  const { service, store, setNow } = setup({ now: new Date('2026-10-19T04:00:00.000Z'), telegram })
  await telegram.configure('123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  store.linkChat('42', 'default', 'Миша')
  service.createEvent('default', { title: 'Планёрка', start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T07:30:00.000Z' })
  service.createTask('default', { title: 'Отправить отчёт', due: '2026-10-19T09:00:00.000Z' })
  assert.equal(dueNotifications(service, 'default', new Date('2026-10-19T04:00:00.000Z')).length, 0)
  const scheduler = new PlanningScheduler(service, telegram)
  setNow(new Date('2026-10-19T05:01:00.000Z'))
  await scheduler.tick()
  await scheduler.tick()
  const texts = () => sent.filter((item) => item.method === 'sendMessage').map((item) => String(item.body.text))
  assert.equal(texts().filter((text) => text.startsWith('План на')).length, 1)
  setNow(new Date('2026-10-19T06:46:00.000Z'))
  await scheduler.tick()
  assert.ok(texts().some((text) => text.includes('Через 14 мин') && text.includes('Планёрка')))
  setNow(new Date('2026-10-19T08:00:00.000Z'))
  await scheduler.tick()
  assert.ok(texts().some((text) => text.includes('Срок через 1 ч') && text.includes('Отправить отчёт')))
  // A reminder missed during downtime is not sent hours later.
  setNow(new Date('2026-10-19T12:00:00.000Z'))
  const before = texts().length
  await scheduler.tick()
  assert.equal(texts().length, before)
  await telegram.stop()
  service.close()
})

void test('HTTP API: events, tasks, drafts, readable validation errors and OAuth state check', async () => {
  const { service } = setup()
  const app = createApp(new TrendResearchService(), { planning: service })
  // The merged app must expose planning alongside the existing wardrobe and trend modules.
  for (const url of ['/api/wardrobe/agent/capabilities', '/api/wardrobe/photos/capabilities', '/api/trends/chat/tools']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url)
  }
  const json = { 'content-type': 'application/json' }
  const created = await app.inject({ method: 'POST', url: '/api/planning/events', headers: json, payload: { title: 'Лекция', start: '2026-10-19T08:00:00+03:00', end: '2026-10-19T09:30:00+03:00', rrule: 'FREQ=WEEKLY;BYDAY=MO' } })
  assert.equal(created.statusCode, 200)
  assert.equal(created.json().start, '2026-10-19T05:00:00.000Z')
  const bad = await app.inject({ method: 'POST', url: '/api/planning/events', headers: json, payload: { title: 'X', start: '2026-10-19T10:00:00Z', end: '2026-10-19T09:00:00Z' } })
  assert.deepEqual([bad.statusCode, bad.json().error], [400, 'Окончание должно быть позже начала'])
  const agenda = await app.inject({ method: 'GET', url: '/api/planning/agenda?from=2026-10-19&days=14' })
  assert.equal(agenda.json().days.filter((day: { occurrences: unknown[] }) => day.occurrences.length).length, 2)
  const draft = await app.inject({ method: 'POST', url: '/api/planning/drafts', headers: json, payload: { text: 'оплатить аренду до 25-го; созвон в пятницу' } })
  assert.equal(draft.json().method, 'parser')
  const incomplete = await app.inject({ method: 'POST', url: `/api/planning/drafts/${draft.json().id}/confirm`, headers: json, payload: {} })
  assert.equal(incomplete.statusCode, 422)
  const fixed = draft.json().items.map((item: { kind: string }) => item.kind === 'event' ? { ...item, start: '2026-10-23T12:00:00.000Z', end: '2026-10-23T13:00:00.000Z' } : item)
  const confirmed = await app.inject({ method: 'POST', url: `/api/planning/drafts/${draft.json().id}/confirm`, headers: json, payload: { items: fixed } })
  assert.deepEqual([confirmed.json().created.events.length, confirmed.json().created.tasks.length], [1, 1])
  const brief = await app.inject({ method: 'GET', url: '/api/planning/brief?date=2026-10-19' })
  assert.match(brief.json().text, /Лекция/)
  const callback = await app.inject({ method: 'GET', url: '/api/planning/google/callback?code=x&state=forged' })
  assert.equal(callback.statusCode, 302)
  assert.match(String(callback.headers.location), /planning=google-error/)
  const telegramToken = await app.inject({ method: 'PUT', url: '/api/planning/telegram', headers: json, payload: { token: 'wrong' } })
  assert.match(telegramToken.json().error, /BotFather/)
  const facts = await app.inject({ method: 'GET', url: '/api/planning/context' })
  assert.ok(facts.json().facts.some((fact: string) => fact.startsWith('Открытых задач: 1')))
  const tools = createPlanningTools(service)
  const slots = await tools.find((tool) => tool.name === 'planning_find_free_slots')!.execute({ days: 1, minutes: 120 }) as { slots: unknown[] }[]
  assert.ok(slots[0].slots.length > 0)
  await app.close()
})

void test('project bot from the server starts with the service; the website only links chats', async () => {
  const { sent } = fakeTelegram()
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(input).split('/').pop()!
    if (method === 'getUpdates') { await new Promise((resolve) => setTimeout(resolve, 20)); return Response.json({ ok: true, result: [] }) }
    sent.push({ method, body: JSON.parse(String(init.body || '{}')) })
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 1, username: 'project_bot', first_name: 'Project' } : true })
  }) as typeof fetch
  const telegram = new TelegramService({ get: () => '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', set: () => { throw new Error('must not store') } }, fetcher, undefined, true)
  const { service } = setup({ telegram })
  registerPlanningCommands(telegram, service)
  await telegram.start()
  const status = service.telegramStatus('default')
  assert.deepEqual([status.configured, status.managed, status.running, status.botUsername], [true, true, true, 'project_bot'])
  assert.ok(sent.some((item) => item.method === 'setMyCommands'))
  await assert.rejects(() => service.configureTelegram('default', { token: '654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }), /TELEGRAM_BOT_TOKEN/)
  await assert.rejects(() => service.removeTelegram('default'), /нельзя отключить/)
  assert.match(String(service.telegramLink('default').url), /^https:\/\/t\.me\/project_bot\?start=/)
  await telegram.stop()
  service.close()
})

void test('forced model run: every segment goes to the model, dates still come from rules', async () => {
  const model = new FakeModel({ items: [{ kind: 'event', title: 'Созвон с бухгалтером', when: 'завтра в 15', deadline: '', duration: '', repeat: '' }], question: '' })
  const extractor = new DraftExtractor(model)
  const auto = await extractor.extract('завтра в 15 созвон с бухгалтером', context)
  assert.deepEqual([auto.method, model.calls], ['parser', 0])
  const forced = await extractor.extract('завтра в 15 созвон с бухгалтером', context, { force: true })
  assert.deepEqual([forced.method, model.calls, forced.items[0].start], ['ai', 1, '2026-10-20T12:00:00.000Z'])
  assert.ok(forced.notes[0].includes('по запросу пользователя'))
  const { service } = setup()
  await assert.rejects(() => service.createDraft('default', { text: 'купить хлеб', force: true }), /Модель не настроена/)
  service.close()
})

void test('enabling a calendar makes it the target for new events; earlier local events can be sent there', () => {
  const { service, store } = setup()
  const before = service.createEvent('default', { title: 'Создано до подключения', start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z' })
  const account = store.saveAccount('default', 'yandex', 'me@yandex.ru', { login: 'me', password: 'x' })
  const [main, second] = store.upsertCalendars(account, [
    { remoteId: '/a/', name: 'Мои события', color: '#fff', writable: true, primary: false },
    { remoteId: '/b/', name: 'ассистент', color: '#fff', writable: true, primary: false },
  ])
  assert.equal(service.settings('default').defaultCalendarId, null)
  service.updateCalendar('default', second.id, { enabled: true })
  assert.equal(service.settings('default').defaultCalendarId, second.id)
  service.updateCalendar('default', main.id, { enabled: true })
  assert.equal(service.settings('default').defaultCalendarId, second.id)
  assert.equal(service.createEvent('default', { title: 'Новое', start: '2026-10-21T07:00:00.000Z', end: '2026-10-21T08:00:00.000Z' }).calendarId, second.id)
  assert.deepEqual(service.localEvents('default').map((event) => event.id), [before.id])
  assert.deepEqual(service.moveLocalEvents('default', second.id), { moved: 1 })
  assert.equal(service.event('default', before.id).calendarId, second.id)
  // Turning the target off moves the default to another enabled calendar.
  service.updateCalendar('default', second.id, { enabled: false })
  assert.equal(service.settings('default').defaultCalendarId, main.id)
  service.close()
})

void test('CalDAV: a server that renames the resource after PUT is followed by UID, and sync re-links instead of duplicating', async () => {
  const stored = '/calendars/user%40yandex.ru/events-1/server-name.ics'
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (init.method === 'PUT') return new Response(null, { status: 201 })
    if (init.method === 'GET') return new Response(null, { status: url.endsWith('server-name.ics') ? 200 : 404, headers: url.endsWith('server-name.ics') ? { ETag: '"7"' } : {} })
    if (init.method === 'REPORT' && String(init.body).includes('prop-filter name="UID"')) return xmlResponse(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${stored.replace('%40', '@')}</d:href><d:propstat><d:prop><d:getetag>"7"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const client = new CalDavClient('user@yandex.ru', 'app-password-123', 'Europe/Moscow', 'https://caldav.yandex.ru/', fetcher)
  const saved = await client.create('/calendars/user%40yandex.ru/events-1/', event({ id: 'abc' }))
  assert.deepEqual([saved.remoteId, saved.etag], [stored, '"7"'])

  // Sync side: our event is linked to an old address, the server lists it under a new one.
  const { store, clock } = setup()
  const remote = new FakeRemote(clock)
  const account = store.saveAccount('default', 'yandex', 'me@yandex.ru', { login: 'me' })
  const [calendar] = store.upsertCalendars(account, await remote.listCalendars())
  store.saveEvent('default', event({ id: 'mine', calendarId: calendar.id }), { remoteId: 'old-name', etag: 'e0', raw: null, remoteUpdated: null, syncedAt: monday.toISOString() })
  remote.items.set('new-name', { data: { uid: 'mine@ai-agents-hse', title: 'Событие', description: '', location: '', allDay: false, start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T08:00:00.000Z', timeZone: 'Europe/Moscow', rrule: null, exdates: [], recurrenceId: null, cancelled: false, updated: null }, etag: 'e1', updated: monday.toISOString() })
  const [report] = await new SyncEngine(store, () => remote, clock).syncAccount(account)
  assert.deepEqual([report.pulled.created, report.pulled.deleted], [0, 0])
  assert.deepEqual(store.events('default').map((item) => item.id), ['mine'])
  assert.equal(store.eventRow('default', 'mine')?.link?.remoteId, 'new-name')
})

/** Scripted tool model: each turn returns the next prepared step and records what it was given. */
class ScriptedAgentModel implements ToolModel {
  readonly provider = 'ollama'
  readonly model = 'scripted'
  seen: { messages: ChatMessage[]; tools: string[] }[] = []
  constructor(private script: ((messages: ChatMessage[]) => { content: string; calls: { id: string; name: string; arguments: unknown }[] })[]) {}
  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    this.seen.push({ messages: [...messages], tools: tools.map((tool) => tool.name) })
    const step = this.script.shift()
    return step ? step(messages) : { content: 'Готово.', calls: [] }
  }
}
const lastTool = (messages: ChatMessage[]) => JSON.parse([...messages].reverse().find((message) => message.role === 'tool')!.content)

void test('assistant dispatcher answers simple requests by rules and sends only planning requests to the agent', () => {
  const route = (text: string, followUp = false) => dispatch(text, context, followUp).route
  assert.equal(route('что у меня завтра?'), 'day_plan')
  assert.equal(route('план на сегодня'), 'day_plan')
  assert.equal(route('какие планы на следующей неделе?'), 'week')
  assert.equal(route('когда я свободен на 2 часа?'), 'free_slots')
  assert.deepEqual([dispatch('когда я свободен на 2 часа на этой неделе?', context).minutes, dispatch('когда я свободен на 2 часа на этой неделе?', context).days], [120, 7])
  assert.equal(route('какие задачи просрочены?'), 'tasks')
  assert.equal(route('завтра в 15 созвон с бухгалтером'), 'draft')
  assert.equal(route('купить молоко'), 'draft')
  assert.equal(route('распланируй подготовку к экзамену: 6 часов до пятницы'), 'agent')
  assert.equal(route('успею ли я всё сделать до пятницы?'), 'agent')
  assert.equal(route('да', true), 'agent')
  assert.equal(route('а можно не больше одного блока в день?', true), 'agent')
})

void test('agent: reads free time, lets code place blocks, returns a draft and saves nothing by itself', async () => {
  const model = new ScriptedAgentModel([
    () => ({ content: '', calls: [{ id: '1', name: 'find_free_slots', arguments: { days: 3, minutes: 120 } }] }),
    // Wrong arguments first: the error goes back to the model, which corrects itself.
    () => ({ content: '', calls: [{ id: '2', name: 'plan_blocks', arguments: { title: 'Матанализ', total_minutes: 'много' } }] }),
    () => ({ content: '', calls: [{ id: '3', name: 'plan_blocks', arguments: { title: 'Матанализ', total_minutes: 360, block_minutes: 120, until: 'до пятницы' } }] }),
    (messages) => ({ content: `Черновик: ${lastTool(messages).result?.blocks?.join(', ') ?? lastTool(messages).blocks.join(', ')}`, calls: [] }),
  ])
  const { service, store } = setup({ agentModel: model })
  service.createEvent('default', { title: 'Лекция', start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T10:00:00.000Z' })
  const reply = await answerRequest(service, 'default', { message: 'распланируй подготовку к экзамену: 6 часов до пятницы блоками по 2 часа' }, model)
  assert.equal(reply.route, 'agent')
  assert.deepEqual(reply.steps.map((step) => [step.tool, step.status]), [['find_free_slots', 'ok'], ['plan_blocks', 'error'], ['plan_blocks', 'ok']])
  assert.equal(reply.draft?.items.length, 3)
  assert.equal(reply.draft?.items.reduce((sum, item) => sum + (item.durationMinutes || 0), 0), 360)
  // Monday is 09:00–19:00 with a lecture 10:00–13:00 local: the first block starts after it.
  assert.equal(reply.draft?.items[0].start, '2026-10-19T10:00:00.000Z')
  assert.ok(reply.draft!.items.every((item) => item.start! < '2026-10-24'))
  assert.equal(store.events('default').length, 1)
  const context = JSON.stringify(model.seen[0].messages.at(-1))
  assert.match(context, /2026-10-23 пятница/)
  assert.ok(model.seen[0].tools.includes('plan_blocks'))
  const confirmed = service.confirmDraft('default', reply.draft!.id)
  assert.deepEqual(confirmed.created.events.map((item) => item.source), ['ai', 'ai', 'ai'])
  service.close()
})

void test('agent proposals are checked by code: past dates, conflicts and the budget are enforced', async () => {
  const model = new ScriptedAgentModel([
    () => ({ content: '', calls: [{ id: '1', name: 'propose', arguments: { items: [{ kind: 'event', title: 'Встреча', date: '2026-10-18', start: '10:00' }] } }] }),
    () => ({ content: '', calls: [{ id: '2', name: 'propose', arguments: { items: [{ kind: 'event', title: 'Встреча', date: '2026-10-19', start: '10:30', end: '11:30' }, { kind: 'task', title: 'Отчёт', date: '2026-10-20', repeat: 'monthly' }] } }] }),
    ...Array.from({ length: 10 }, (_, index) => () => ({ content: '', calls: [{ id: `x${index}`, name: 'get_day_plan', arguments: { date: '2026-10-19' } }] })),
  ])
  const { service } = setup({ agentModel: model })
  service.createEvent('default', { title: 'Планёрка', start: '2026-10-19T07:00:00.000Z', end: '2026-10-19T08:00:00.000Z' })
  const reply = await answerRequest(service, 'default', { message: 'предложи время для встречи', mode: 'agent' }, model)
  assert.match(reply.steps[0].summary, /вне допустимого периода/)
  assert.deepEqual(reply.draft?.items[0].conflicts.map((item) => item.title), ['Планёрка'])
  assert.equal(reply.draft?.items[1].rrule, 'FREQ=MONTHLY;BYMONTHDAY=20')
  // The loop stops at the turn budget and the last turn has no tools.
  assert.equal(model.seen.length, 8)
  assert.deepEqual(model.seen.at(-1)!.tools, [])
  service.close()
})

void test('without a model the assistant still answers simple requests and explains the limit', async () => {
  const { service } = setup()
  service.createTask('default', { title: 'Налог', due: '2026-10-15' })
  const tasks = await service.ask('default', { message: 'какие задачи просрочены?' })
  assert.deepEqual([tasks.route, tasks.model], ['tasks', null])
  assert.match(tasks.answer, /Просрочено \(1\)/)
  const planning = await service.ask('default', { message: 'распланируй мне неделю' })
  assert.equal(planning.route, 'help')
  assert.match(planning.answer, /нужна модель/)
  const draft = await service.ask('default', { message: 'завтра в 15 созвон' })
  assert.deepEqual([draft.route, draft.draft?.items[0].start], ['draft', '2026-10-20T12:00:00.000Z'])
  service.close()
})
