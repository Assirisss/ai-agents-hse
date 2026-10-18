/** Time-zone arithmetic without extra dependencies: Intl gives offsets, everything else is plain dates. */

export type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string) {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(timeZone, value)
  }
  return value
}

export function isTimeZone(value: string) {
  try { formatter(value); return true } catch { return false }
}

export function wallTime(date: Date, timeZone: string): WallTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second }
}

/** Offset of the zone from UTC in milliseconds at the given instant. */
export function zoneOffset(date: Date, timeZone: string) {
  const wall = wallTime(date, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(date.getTime() / 1000) * 1000
}

/** Convert a local wall-clock time to an instant; a time skipped by DST moves forward. */
export function fromWallTime(wall: Omit<WallTime, 'second'> & { second?: number }, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0)
  const first = guess - zoneOffset(new Date(guess), timeZone)
  const second = guess - zoneOffset(new Date(first), timeZone)
  return new Date(second)
}

export const pad = (value: number, size = 2) => String(value).padStart(size, '0')
export const dateKey = (wall: Pick<WallTime, 'year' | 'month' | 'day'>) => `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
export const localDate = (date: Date, timeZone: string) => dateKey(wallTime(date, timeZone))
export const localTime = (date: Date, timeZone: string) => { const wall = wallTime(date, timeZone); return `${pad(wall.hour)}:${pad(wall.minute)}` }

export function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Некорректная дата: ${value}`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error(`Некорректная дата: ${value}`)
  return { year, month, day }
}
export const isDateKey = (value: string) => { try { parseDateKey(value); return true } catch { return false } }

export function addDays(value: string, days: number) {
  const { year, month, day } = parseDateKey(value)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return dateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() })
}
export function daysBetween(from: string, to: string) {
  const a = parseDateKey(from), b = parseDateKey(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
}
/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekday(value: string) {
  const { year, month, day } = parseDateKey(value)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7
}

/** Start and exclusive end of a local calendar day. */
export function dayRange(value: string, timeZone: string) {
  const { year, month, day } = parseDateKey(value)
  const next = parseDateKey(addDays(value, 1))
  return { start: fromWallTime({ year, month, day, hour: 0, minute: 0 }, timeZone), end: fromWallTime({ ...next, hour: 0, minute: 0 }, timeZone) }
}

export function atLocalTime(date: string, time: string, timeZone: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) throw new Error(`Некорректное время: ${time}`)
  return fromWallTime({ ...parseDateKey(date), hour: Number(match[1]), minute: Number(match[2]) }, timeZone)
}

const weekdays = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье']
const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
export const weekdayName = (value: string) => weekdays[weekday(value) - 1]
export function humanDate(value: string, withWeekday = true) {
  const { month, day } = parseDateKey(value)
  return `${withWeekday ? `${weekdayName(value)}, ` : ''}${day} ${months[month - 1]}`
}
export function formatMinutes(total: number) {
  const hours = Math.floor(total / 60), minutes = total % 60
  if (!hours) return `${minutes} мин`
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`
}
