import ICAL from 'ical.js'
import type { Occurrence, PlanningEvent } from '../../../shared/planning.js'
import { addDays, dateKey, dayRange, daysBetween, fromWallTime, isDateKey, wallTime } from './time.js'

const maxIterations = 20000

/** Comparable key of an occurrence start: the date for all-day values, epoch milliseconds otherwise. */
export const occurrenceKey = (value: string) => isDateKey(value) ? value : String(Date.parse(value))

export function bounds(item: { start: string; end: string; allDay: boolean }, timeZone: string) {
  if (!item.allDay) return { start: new Date(item.start), end: new Date(item.end) }
  return { start: dayRange(item.start, timeZone).start, end: dayRange(item.end, timeZone).start }
}

export function validRule(rrule: string) {
  try {
    const recur = ICAL.Recur.fromString(rrule)
    return Boolean(recur.freq)
  } catch { return false }
}

/** Iteration happens on the event's wall clock, so a UTC UNTIL is converted to that clock first. */
function localRule(rrule: string, timeZone: string, allDay: boolean) {
  const recur = ICAL.Recur.fromString(rrule)
  if (recur.until && !allDay && !recur.until.isDate && recur.until.zone === ICAL.Timezone.utcTimezone) {
    recur.until = ICAL.Time.fromData({ ...wallTime(recur.until.toJSDate(), timeZone), isDate: false })
  }
  return recur
}

function occurrence(event: PlanningEvent, start: string, end: string): Occurrence {
  return { eventId: event.id, title: event.title, location: event.location, start, end, allDay: event.allDay, calendarId: event.calendarId, source: event.source, recurring: Boolean(event.rrule || event.recurrenceOf), readOnly: event.readOnly }
}

/** Occurrences of one event that overlap [from, to). `hidden` holds keys replaced by exceptions. */
export function expandEvent(event: PlanningEvent, from: Date, to: Date, timeZone: string, hidden = new Set<string>()): Occurrence[] {
  if (event.cancelled) return []
  const excluded = new Set([...event.exdates.map(occurrenceKey), ...hidden])
  if (!event.rrule) {
    const range = bounds(event, timeZone)
    return range.start < to && range.end > from ? [occurrence(event, event.start, event.end)] : []
  }
  const result: Occurrence[] = []
  const recur = localRule(event.rrule, event.timeZone, event.allDay)
  if (event.allDay) {
    const length = Math.max(1, daysBetween(event.start, event.end))
    const iterator = recur.iterator(ICAL.Time.fromDateString(event.start))
    for (let index = 0, next = iterator.next(); next && index < maxIterations; index++, next = iterator.next()) {
      const date = dateKey(next)
      const start = dayRange(date, timeZone).start
      if (start >= to) break
      const endDate = addDays(date, length)
      if (dayRange(endDate, timeZone).start > from && !excluded.has(date)) result.push(occurrence(event, date, endDate))
    }
    return result
  }
  const duration = Date.parse(event.end) - Date.parse(event.start)
  const iterator = recur.iterator(ICAL.Time.fromData({ ...wallTime(new Date(event.start), event.timeZone), isDate: false }))
  for (let index = 0, next = iterator.next(); next && index < maxIterations; index++, next = iterator.next()) {
    const start = fromWallTime({ year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second }, event.timeZone)
    if (start >= to) break
    const end = new Date(start.getTime() + duration)
    if (end > from && !excluded.has(String(start.getTime()))) result.push(occurrence(event, start.toISOString(), end.toISOString()))
  }
  return result
}

/** Next start of a repeating series strictly after `start` (a date or an instant); null when the rule ends. */
export function nextOccurrence(rrule: string, start: string, timeZone: string): string | null {
  const allDay = isDateKey(start)
  const iterator = localRule(rrule, timeZone, allDay).iterator(allDay ? ICAL.Time.fromDateString(start) : ICAL.Time.fromData({ ...wallTime(new Date(start), timeZone), isDate: false }))
  for (let index = 0, next = iterator.next(); next && index < 1000; index++, next = iterator.next()) {
    const value = allDay ? dateKey(next) : fromWallTime({ year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second }, timeZone).toISOString()
    if (allDay ? value > start : Date.parse(value) > Date.parse(start)) return value
  }
  return null
}

/** All occurrences in [from, to), sorted. Exceptions replace or cancel occurrences of their series. */
export function expandEvents(events: PlanningEvent[], from: Date, to: Date, timeZone: string): Occurrence[] {
  const hidden = new Map<string, Set<string>>()
  for (const event of events) {
    if (!event.recurrenceOf || !event.recurrenceId) continue
    const keys = hidden.get(event.recurrenceOf) || new Set<string>()
    keys.add(occurrenceKey(event.recurrenceId))
    hidden.set(event.recurrenceOf, keys)
  }
  return events.flatMap((event) => expandEvent(event, from, to, timeZone, hidden.get(event.id)))
    .sort((a, b) => bounds(a, timeZone).start.getTime() - bounds(b, timeZone).start.getTime() || a.title.localeCompare(b.title))
}
