import type { Agenda, Conflict, DayBrief, Occurrence, PlanningEvent, PlanningSettings, PlanningTask, TimeSlot } from '../../../shared/planning.js'
import { bounds, expandEvents } from './recurrence.js'
import { addDays, atLocalTime, dayRange, formatMinutes, humanDate, localDate, localTime } from './time.js'

/** Everything in this file is ordinary calculation: no model is involved in the daily plan. */

export const taskDueDate = (task: PlanningTask, timeZone: string) => task.due ? (task.dueHasTime ? localDate(new Date(task.due), timeZone) : task.due) : null

export function isOverdue(task: PlanningTask, now: Date, timeZone: string) {
  if (task.status !== 'open' || !task.due) return false
  return task.dueHasTime ? Date.parse(task.due) < now.getTime() : task.due < localDate(now, timeZone)
}

const byDeadline = (timeZone: string) => (a: PlanningTask, b: PlanningTask) =>
  (taskDueDate(a, timeZone) || '9999').localeCompare(taskDueDate(b, timeZone) || '9999') || Number(b.dueHasTime) - Number(a.dueHasTime) || (a.due || '').localeCompare(b.due || '') || a.priority - b.priority

export function findConflicts(occurrences: Occurrence[], timeZone: string, limit = 20): Conflict[] {
  const timed = occurrences.filter((item) => !item.allDay).map((item) => ({ item, ...bounds(item, timeZone) })).sort((a, b) => a.start.getTime() - b.start.getTime())
  const result: Conflict[] = []
  for (let i = 0; i < timed.length && result.length < limit; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) {
      const overlap = Math.min(timed[i].end.getTime(), timed[j].end.getTime()) - timed[j].start.getTime()
      if (overlap > 0) result.push({ first: timed[i].item, second: timed[j].item, overlapMinutes: Math.round(overlap / 60000) })
    }
  }
  return result
}

function mergeBusy(intervals: { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = []
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

/** Free gaps of at least `minimum` minutes inside working hours; today starts from the current time. */
export function freeSlots(occurrences: Occurrence[], date: string, settings: PlanningSettings, now: Date, minimum = 15) {
  const windowStart = atLocalTime(date, settings.workStart, settings.timeZone).getTime()
  const windowEnd = atLocalTime(date, settings.workEnd, settings.timeZone).getTime()
  const from = Math.max(windowStart, Math.ceil(now.getTime() / 300000) * 300000)
  const busy = mergeBusy(occurrences.filter((item) => !item.allDay).map((item) => bounds(item, settings.timeZone))
    .map((item) => ({ start: Math.max(item.start.getTime(), windowStart), end: Math.min(item.end.getTime(), windowEnd) })).filter((item) => item.end > item.start))
  const slots: TimeSlot[] = []
  let cursor = from
  for (const interval of [...busy, { start: windowEnd, end: windowEnd }]) {
    if (interval.start - cursor >= minimum * 60000) slots.push({ start: new Date(cursor).toISOString(), end: new Date(interval.start).toISOString(), minutes: Math.round((interval.start - cursor) / 60000) })
    cursor = Math.max(cursor, interval.end)
  }
  const busyMinutes = Math.round(busy.reduce((sum, item) => sum + item.end - item.start, 0) / 60000)
  return { slots, busyMinutes }
}

export function dayBrief(events: PlanningEvent[], tasks: PlanningTask[], date: string, settings: PlanningSettings, now: Date): DayBrief {
  const timeZone = settings.timeZone
  const range = dayRange(date, timeZone)
  const occurrences = expandEvents(events, range.start, range.end, timeZone)
  const open = tasks.filter((task) => task.status === 'open')
  const isToday = date === localDate(now, timeZone)
  const tasksDue = open.filter((task) => taskDueDate(task, timeZone) === date && !(isToday && isOverdue(task, now, timeZone))).sort(byDeadline(timeZone))
  const overdue = isToday ? open.filter((task) => isOverdue(task, now, timeZone)).sort(byDeadline(timeZone)) : []
  const { slots, busyMinutes } = freeSlots(occurrences, date, settings, date < localDate(now, timeZone) ? range.end : isToday ? now : range.start)
  const freeMinutes = slots.reduce((sum, slot) => sum + slot.minutes, 0)
  const plannedTaskMinutes = [...tasksDue, ...overdue].reduce((sum, task) => sum + (task.durationMinutes || 0), 0)
  const brief: DayBrief = {
    date, timeZone, generatedAt: now.toISOString(),
    events: occurrences.filter((item) => !item.allDay), allDay: occurrences.filter((item) => item.allDay),
    tasksDue, overdue, conflicts: findConflicts(occurrences, timeZone), freeSlots: slots,
    busyMinutes, freeMinutes, plannedTaskMinutes, overload: plannedTaskMinutes > freeMinutes, text: '',
  }
  brief.text = briefText(brief)
  return brief
}

const span = (item: Occurrence, timeZone: string) => `${localTime(new Date(item.start), timeZone)}–${localTime(new Date(item.end), timeZone)}`
const sourceMark = (item: Occurrence) => item.source === 'google' ? ' · Google' : item.source === 'yandex' ? ' · Яндекс' : ''
export function taskLine(task: PlanningTask, timeZone: string, withDate = false) {
  const due = !task.due ? '' : task.dueHasTime
    ? ` — до ${withDate ? `${humanDate(localDate(new Date(task.due), timeZone), false)} ` : ''}${localTime(new Date(task.due), timeZone)}`
    : withDate ? ` — срок ${humanDate(task.due, false)}` : ''
  return `${task.priority === 1 ? '‼ ' : ''}${task.title}${due}${task.durationMinutes ? ` (${formatMinutes(task.durationMinutes)})` : ''}`
}

/** Plain text used by Telegram and by the morning report. */
export function briefText(brief: DayBrief) {
  const zone = brief.timeZone
  const lines = [`План на ${humanDate(brief.date)}`, '']
  const total = brief.events.length + brief.allDay.length
  if (!total) lines.push('Событий нет.')
  else {
    lines.push(`События (${total}):`)
    for (const item of brief.allDay) lines.push(`• весь день — ${item.title}${sourceMark(item)}`)
    for (const item of brief.events) lines.push(`• ${span(item, zone)} ${item.title}${item.location ? ` (${item.location})` : ''}${sourceMark(item)}`)
  }
  if (brief.conflicts.length) {
    lines.push('', '⚠ Пересечения:')
    for (const conflict of brief.conflicts) lines.push(`• ${localTime(new Date(conflict.first.start), zone)} ${conflict.first.title} и ${localTime(new Date(conflict.second.start), zone)} ${conflict.second.title} (${formatMinutes(conflict.overlapMinutes)})`)
  }
  lines.push('')
  if (brief.tasksDue.length) { lines.push(`Задачи на день (${brief.tasksDue.length}):`); for (const task of brief.tasksDue) lines.push(`• ${taskLine(task, zone)}`) }
  else lines.push('Задач со сроком на этот день нет.')
  if (brief.overdue.length) { lines.push('', `Просрочено (${brief.overdue.length}):`); for (const task of brief.overdue.slice(0, 10)) lines.push(`• ${taskLine(task, zone, true)}`) }
  lines.push('', brief.freeSlots.length
    ? `Свободно в рабочие часы: ${brief.freeSlots.map((slot) => `${localTime(new Date(slot.start), zone)}–${localTime(new Date(slot.end), zone)}`).join(', ')} (${formatMinutes(brief.freeMinutes)})`
    : 'Свободного времени в рабочие часы не осталось.')
  if (brief.plannedTaskMinutes) lines.push(brief.overload
    ? `⚠ Задачам нужно ${formatMinutes(brief.plannedTaskMinutes)}, а свободно ${formatMinutes(brief.freeMinutes)}: часть стоит перенести.`
    : `Задачам нужно ${formatMinutes(brief.plannedTaskMinutes)} — помещаются в свободное время.`)
  return lines.join('\n')
}

export function agenda(events: PlanningEvent[], tasks: PlanningTask[], from: string, days: number, settings: PlanningSettings, now: Date): Agenda {
  const timeZone = settings.timeZone
  const occurrences = expandEvents(events, dayRange(from, timeZone).start, dayRange(addDays(from, days - 1), timeZone).end, timeZone)
  const open = tasks.filter((task) => task.status === 'open')
  return {
    from,
    days: Array.from({ length: days }, (_, index) => {
      const date = addDays(from, index)
      const range = dayRange(date, timeZone)
      return { date, occurrences: occurrences.filter((item) => { const value = bounds(item, timeZone); return value.start < range.end && value.end > range.start }), tasks: tasks.filter((task) => taskDueDate(task, timeZone) === date).sort(byDeadline(timeZone)) }
    }),
    undated: open.filter((task) => !task.due).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)),
    overdue: open.filter((task) => isOverdue(task, now, timeZone)).sort(byDeadline(timeZone)),
  }
}

export function weekText(value: Agenda, timeZone: string) {
  const lines = [`План на неделю с ${humanDate(value.from, false)}`]
  for (const day of value.days) {
    const open = day.tasks.filter((task) => task.status === 'open')
    lines.push('', `${humanDate(day.date)}${!day.occurrences.length && !open.length ? ' — свободно' : ''}`)
    for (const item of day.occurrences.slice(0, 8)) lines.push(`• ${item.allDay ? 'весь день' : span(item, timeZone)} ${item.title}`)
    if (day.occurrences.length > 8) lines.push(`• …и ещё ${day.occurrences.length - 8}`)
    for (const task of open.slice(0, 5)) lines.push(`☐ ${taskLine(task, timeZone)}`)
  }
  if (value.overdue.length) lines.push('', `Просрочено задач: ${value.overdue.length}`)
  return lines.join('\n')
}
