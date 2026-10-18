import ICAL from 'ical.js'
import type { PlanningEvent } from '../../../shared/planning.js'
import { addDays, dateKey, fromWallTime, isTimeZone, wallTime, zoneOffset } from './time.js'

/** Fields of one VEVENT in our representation: UTC instants for timed values, dates for all-day ones. */
export type RemoteEventData = {
  uid: string
  title: string
  description: string
  location: string
  allDay: boolean
  start: string
  end: string
  timeZone: string
  rrule: string | null
  exdates: string[]
  recurrenceId: string | null
  cancelled: boolean
  updated: string | null
}

const fields = (time: ICAL.Time) => ({ year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second })

/** Convert an iCalendar time using its TZID: IANA names through Intl, other names through an embedded VTIMEZONE. */
function convert(time: ICAL.Time, tzid: string | undefined, fallbackTz: string): { value: string; allDay: boolean; zone: string } {
  if (time.isDate) return { value: dateKey(time), allDay: true, zone: tzid && isTimeZone(tzid) ? tzid : fallbackTz }
  if (time.zone === ICAL.Timezone.utcTimezone) return { value: time.toJSDate().toISOString(), allDay: false, zone: tzid && isTimeZone(tzid) ? tzid : fallbackTz }
  if (tzid && isTimeZone(tzid)) return { value: fromWallTime(fields(time), tzid).toISOString(), allDay: false, zone: tzid }
  if (time.zone && time.zone !== ICAL.Timezone.localTimezone) return { value: time.toJSDate().toISOString(), allDay: false, zone: fallbackTz }
  return { value: fromWallTime(fields(time), fallbackTz).toISOString(), allDay: false, zone: fallbackTz }
}

function propertyTime(property: ICAL.Property | null, fallbackTz: string) {
  if (!property) return null
  const value = property.getFirstValue()
  if (!(value instanceof ICAL.Time)) return null
  return convert(value, property.getParameter('tzid') as string | undefined, fallbackTz)
}

function readEvent(event: ICAL.Component, fallbackTz: string): RemoteEventData | null {
  const start = propertyTime(event.getFirstProperty('dtstart'), fallbackTz)
  if (!start) return null
  let end = propertyTime(event.getFirstProperty('dtend'), fallbackTz)?.value
  if (!end) {
    const duration = event.getFirstPropertyValue('duration')
    if (duration instanceof ICAL.Duration) end = start.allDay ? addDays(start.value, Math.max(1, Math.round(duration.toSeconds() / 86400))) : new Date(Date.parse(start.value) + duration.toSeconds() * 1000).toISOString()
    else end = start.allDay ? addDays(start.value, 1) : start.value
  }
  const rule = event.getFirstPropertyValue('rrule')
  const exdates = event.getAllProperties('exdate').flatMap((property) => property.getValues().filter((value): value is ICAL.Time => value instanceof ICAL.Time).map((value) => convert(value, property.getParameter('tzid') as string | undefined, start.zone).value))
  const recurrence = propertyTime(event.getFirstProperty('recurrence-id'), start.zone)
  const modified = event.getFirstPropertyValue('last-modified') || event.getFirstPropertyValue('dtstamp')
  const text = (name: string) => { const value = event.getFirstPropertyValue(name); return typeof value === 'string' ? value : '' }
  return {
    uid: text('uid'), title: text('summary').trim() || 'Без названия', description: text('description'), location: text('location'),
    allDay: start.allDay, start: start.value, end, timeZone: start.zone,
    rrule: rule instanceof ICAL.Recur ? rule.toString() : null, exdates, recurrenceId: recurrence?.value ?? null,
    cancelled: text('status').toUpperCase() === 'CANCELLED', updated: modified instanceof ICAL.Time ? modified.toJSDate().toISOString() : null,
  }
}

/** One CalDAV resource: the series master and its changed occurrences. */
export function parseIcs(ics: string, fallbackTz: string): { master: RemoteEventData | null; exceptions: RemoteEventData[] } {
  const calendar = new ICAL.Component(ICAL.parse(ics))
  // Non-IANA TZIDs (e.g. Windows names) resolve through the VTIMEZONE shipped in the same file.
  for (const zone of calendar.getAllSubcomponents('vtimezone')) {
    const tzid = zone.getFirstPropertyValue('tzid')
    if (typeof tzid === 'string' && !isTimeZone(tzid) && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(zone)
  }
  const events = calendar.getAllSubcomponents('vevent').map((item) => readEvent(item, fallbackTz)).filter((item): item is RemoteEventData => item !== null)
  return { master: events.find((item) => !item.recurrenceId) ?? null, exceptions: events.filter((item) => item.recurrenceId) }
}

function setTime(component: ICAL.Component, name: string, value: string, event: PlanningEvent) {
  component.removeAllProperties(name)
  const property = new ICAL.Property(name)
  if (event.allDay) { property.resetType('date'); property.setValue(ICAL.Time.fromDateString(value)) }
  else if (event.rrule) {
    // A series keeps its wall-clock time across DST changes only with a TZID.
    property.setValue(ICAL.Time.fromData({ ...wallTime(new Date(value), event.timeZone), isDate: false }))
    property.setParameter('tzid', event.timeZone)
  } else property.setValue(ICAL.Time.fromJSDate(new Date(value), true))
  component.addProperty(property)
}

/**
 * Minimal VTIMEZONE with the current offset. Exact for zones without DST (e.g. Europe/Moscow);
 * servers that know the IANA TZID, such as Yandex and Google, use their own rules anyway.
 */
function ensureTimezone(calendar: ICAL.Component, timeZone: string, now: Date) {
  if (calendar.getAllSubcomponents('vtimezone').some((zone) => zone.getFirstPropertyValue('tzid') === timeZone)) return
  const minutes = Math.round(zoneOffset(now, timeZone) / 60000)
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}${String(Math.abs(minutes) % 60).padStart(2, '0')}`
  const zone = new ICAL.Component(ICAL.parse(`BEGIN:VTIMEZONE\r\nTZID:${timeZone}\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:${offset}\r\nTZOFFSETTO:${offset}\r\nEND:STANDARD\r\nEND:VTIMEZONE`))
  const first = calendar.getFirstSubcomponent('vevent')
  if (first) calendar.removeSubcomponent(first)
  calendar.addSubcomponent(zone)
  if (first) calendar.addSubcomponent(first)
}

/** Build a resource for upload. With `raw`, only the master's own fields change; the rest is preserved. */
export function buildIcs(event: PlanningEvent, uid: string, raw: string | null, now = new Date()): string {
  let calendar: ICAL.Component
  let master: ICAL.Component | undefined
  if (raw) {
    calendar = new ICAL.Component(ICAL.parse(raw))
    master = calendar.getAllSubcomponents('vevent').find((item) => !item.hasProperty('recurrence-id'))
  } else {
    calendar = new ICAL.Component(['vcalendar', [], []])
    calendar.updatePropertyWithValue('prodid', '-//AI Agents HSE//Planning//RU')
    calendar.updatePropertyWithValue('version', '2.0')
    calendar.updatePropertyWithValue('calscale', 'GREGORIAN')
  }
  if (!master) {
    master = new ICAL.Component('vevent')
    master.updatePropertyWithValue('uid', uid)
    master.updatePropertyWithValue('created', ICAL.Time.fromJSDate(now, true))
    calendar.addSubcomponent(master)
  }
  master.updatePropertyWithValue('summary', event.title)
  for (const [name, value] of [['description', event.description], ['location', event.location]] as const) {
    if (value) master.updatePropertyWithValue(name, value)
    else master.removeAllProperties(name)
  }
  setTime(master, 'dtstart', event.start, event)
  master.removeAllProperties('duration')
  setTime(master, 'dtend', event.end, event)
  master.removeAllProperties('rrule')
  master.removeAllProperties('exdate')
  if (event.rrule) {
    master.addPropertyWithValue('rrule', ICAL.Recur.fromString(event.rrule))
    for (const value of event.exdates) setTimeList(master, value, event)
    if (!event.allDay) ensureTimezone(calendar, event.timeZone, now)
  }
  master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true))
  master.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(now, true))
  const sequence = Number(master.getFirstPropertyValue('sequence') || 0)
  master.updatePropertyWithValue('sequence', Number.isFinite(sequence) ? sequence + 1 : 1)
  return calendar.toString()
}

/** Google keeps recurrence as iCalendar lines: `RRULE:…`, `EXDATE;TZID=…:…`. */
export function readRecurrenceLines(lines: string[], timeZone: string) {
  let rrule: string | null = null
  const exdates: string[] = []
  for (const line of lines) {
    if (/^RRULE:/i.test(line)) rrule = line.slice(6)
    else if (/^EXDATE/i.test(line)) {
      const property = ICAL.Property.fromString(line)
      for (const value of property.getValues()) if (value instanceof ICAL.Time) exdates.push(convert(value, property.getParameter('tzid') as string | undefined, timeZone).value)
    }
  }
  return { rrule, exdates }
}
export function recurrenceLines(event: PlanningEvent) {
  if (!event.rrule) return []
  return [`RRULE:${event.rrule}`, ...event.exdates.map((value) => {
    const property = new ICAL.Property('exdate')
    if (event.allDay) { property.resetType('date'); property.setValue(ICAL.Time.fromDateString(value)) }
    else { property.setValue(ICAL.Time.fromData({ ...wallTime(new Date(value), event.timeZone), isDate: false })); property.setParameter('tzid', event.timeZone) }
    return property.toICALString()
  })]
}

function setTimeList(component: ICAL.Component, value: string, event: PlanningEvent) {
  const property = new ICAL.Property('exdate')
  if (event.allDay) { property.resetType('date'); property.setValue(ICAL.Time.fromDateString(value)) }
  else { property.setValue(ICAL.Time.fromData({ ...wallTime(new Date(value), event.timeZone), isDate: false })); property.setParameter('tzid', event.timeZone) }
  component.addProperty(property)
}
