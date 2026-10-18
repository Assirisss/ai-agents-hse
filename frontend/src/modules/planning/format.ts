/** Display and form helpers. Times are shown in the profile time zone, not in the browser's one. */

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

function parts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour === '24' ? '00' : values.hour}:${values.minute}` }
}

export const localDate = (iso: string | Date, timeZone: string) => parts(new Date(iso), timeZone).date
export const localTime = (iso: string, timeZone: string) => parts(new Date(iso), timeZone).time

/** Wall-clock date and time in a zone → UTC ISO string (two passes handle DST edges). */
export function zonedToIso(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const offset = (at: number) => { const value = parts(new Date(at), timeZone); const [y, m, d] = value.date.split('-').map(Number); const [h, mi] = value.time.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - Math.floor(at / 60000) * 60000 }
  const first = guess - offset(guess)
  return new Date(guess - offset(first)).toISOString()
}

export function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
export const weekdayIndex = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7
export const startOfWeek = (date: string) => addDays(date, 1 - weekdayIndex(date))

const dayFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
const shortFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
export const humanDay = (date: string) => dayFormat.format(new Date(`${date}T12:00:00Z`))
export const shortDay = (date: string) => shortFormat.format(new Date(`${date}T12:00:00Z`))

export function relativeDay(date: string, today: string) {
  if (date === today) return 'Сегодня'
  if (date === addDays(today, 1)) return 'Завтра'
  if (date === addDays(today, -1)) return 'Вчера'
  return humanDay(date)
}

export function minutesText(total: number) {
  const hours = Math.floor(total / 60), minutes = total % 60
  if (!hours) return `${minutes} мин`
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`
}

export function range(start: string, end: string, allDay: boolean, timeZone: string) {
  if (allDay) return 'весь день'
  return `${localTime(start, timeZone)}–${localTime(end, timeZone)}`
}

export function dueText(due: string | null, dueHasTime: boolean, timeZone: string, today: string) {
  if (!due) return 'без срока'
  if (!dueHasTime || isDate(due)) return relativeDay(due, today)
  return `${relativeDay(localDate(due, timeZone), today)}, ${localTime(due, timeZone)}`
}

const dayNames: Record<string, string> = { MO: 'пн', TU: 'вт', WE: 'ср', TH: 'чт', FR: 'пт', SA: 'сб', SU: 'вс' }
export function ruleText(rrule: string | null | undefined) {
  if (!rrule) return ''
  const values = Object.fromEntries(rrule.split(';').map((part) => part.split('=')))
  const interval = Number(values.INTERVAL || 1)
  if (values.FREQ === 'DAILY') return interval > 1 ? `каждые ${interval} дн.` : 'каждый день'
  if (values.FREQ === 'WEEKLY') {
    if (values.BYDAY === 'MO,TU,WE,TH,FR') return 'по будням'
    const days = values.BYDAY ? values.BYDAY.split(',').map((day: string) => dayNames[day] || day).join(', ') : ''
    return `${interval > 1 ? `раз в ${interval} нед.` : 'еженедельно'}${days ? `: ${days}` : ''}`
  }
  if (values.FREQ === 'MONTHLY') return values.BYMONTHDAY ? `ежемесячно, ${values.BYMONTHDAY}-го` : 'ежемесячно'
  if (values.FREQ === 'YEARLY') return 'ежегодно'
  return 'повторяется'
}

export const repeatOptions = [
  { value: '', label: 'Не повторять' }, { value: 'FREQ=DAILY', label: 'Каждый день' }, { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'По будням' },
  { value: 'FREQ=WEEKLY', label: 'Каждую неделю' }, { value: 'FREQ=MONTHLY', label: 'Каждый месяц' }, { value: 'FREQ=YEARLY', label: 'Каждый год' },
]

export const sourceLabel: Record<string, string> = { manual: 'вручную', parser: 'разобрано правилами', ai: 'предложено моделью', google: 'Google', yandex: 'Яндекс' }
