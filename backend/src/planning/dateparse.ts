import type { DraftItem } from '../../../shared/planning.js'
import { addDays, atLocalTime, dateKey, daysBetween, localDate, localTime, pad, parseDateKey, wallTime, weekday } from './time.js'

/**
 * Deterministic Russian date and time parser. It covers typical phrases without a language model
 * and reports every assumption, so the user can check it before saving.
 */
export type ParseContext = { now: Date; timeZone: string }
export type Clock = { hour: number; minute: number }
export type ParsedItem = Omit<DraftItem, 'conflicts'> & {
  /** Words such as «скоро» or «на днях» that rules cannot turn into a date. */
  vague: string[]
  /** Several separate dates or times in one sentence: likely several items. */
  compound: boolean
  /** At least one date, time, deadline or recurrence was recognized. */
  recognized: boolean
}

const L = '(?<![\\p{L}\\p{N}])'
const R = '(?![\\p{L}\\p{N}])'
const rx = (source: string) => new RegExp(`${L}(?:${source})${R}`, 'gu')

const MONTH = '(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[яй]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья]|янв|февр?|мар|апр|авг|сент?|окт|нояб?|дек)\\.?'
const WEEKDAY = '(понедельник[а-я]*|вторник[а-я]*|сред[аеуы]|средам|четверг[а-я]*|пятниц[аеуы]|пятницам|суббот[аеуы]|субботам|воскресень[еяю]|воскресеньям|пн|вт|ср|чт|пт|сб|вс)'
const numberWords: Record<string, number> = {
  один: 1, одну: 1, одного: 1, час: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, шести: 6,
  семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12,
}
const NUM = `(\\d{1,2}|${Object.keys(numberWords).filter((word) => word !== 'час').join('|')})`
const QUALIFIER = '(утра|дня|вечера|ночи)'
const DEADLINE = '(?:до|не\\s+позднее|не\\s+позже|дедлайн(?:\\s+до)?|срок(?:\\s+до)?|к|ко)'
const monthStems = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const weekdayStems = [['пон', 'пн'], ['вто', 'вт'], ['сре', 'ср'], ['чет', 'чт'], ['пят', 'пт'], ['суб', 'сб'], ['вос', 'вс']]
const icalDays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const monthOf = (word: string) => monthStems.findIndex((stem) => word.startsWith(stem)) + 1
const weekdayOf = (word: string) => weekdayStems.findIndex((stems) => stems.some((stem) => word.startsWith(stem))) + 1
const toNumber = (value: string) => /^\d+$/.test(value) ? Number(value) : numberWords[value] ?? NaN

const eventWords = /(встреч|созвон|совещан|собрани|звонок|колл|митинг|прием|урок|лекци|семинар|пары|экзамен|зачет|тренировк|ужин|обед с|завтрак с|день рождени|концерт|вебинар|собеседован|конференц|спектакл|кино|свидани|поездк|рейс|поезд|отпуск|праздник|мероприят|стрижк|врач|стоматолог|командировк|занятие)/
const allDayWords = /(день рождени|отпуск|праздник|весь день|выходной|командировк)/
const taskVerbs = /^(сделать|купить|оплатить|заплатить|отправить|подготовить|написать|сдать|проверить|заказать|забрать|починить|прочитать|выучить|подать|отнести|позвонить|ответить|закончить|доделать|оформить|подписать|продлить|записаться|перевести|скинуть|получить|найти|разобрать|убрать|постирать)/
const partOfDay: Record<string, Clock> = { утром: { hour: 9, minute: 0 }, 'с утра': { hour: 9, minute: 0 }, днем: { hour: 13, minute: 0 }, 'в обед': { hour: 13, minute: 0 }, 'после обеда': { hour: 14, minute: 0 }, вечером: { hour: 19, minute: 0 }, ночью: { hour: 22, minute: 0 } }

type WeekdayRef = { day: number; modifier: 'next' | 'this' | null }
type RuleParts = { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; byDay: string[]; byMonthDay: number | null }
type State = {
  date: string | null; weekday: WeekdayRef | null; time: Clock | null; endTime: Clock | null; duration: number | null
  deadlineDate: string | null; deadlineWeekday: WeekdayRef | null; deadlineTime: Clock | null
  rule: RuleParts | null; reminder: boolean; kind: 'event' | 'task' | null; allDayHint: boolean
  period: { kind: 'week' | 'next-week' | 'month'; label: string } | null
  assumptions: string[]; vague: string[]; dates: number; times: number
}

class Scanner {
  readonly text: string
  readonly spans: [number, number][] = []
  constructor(source: string) {
    // Lowercase character by character so that indexes stay aligned with the original text.
    this.text = [...source].map((char) => { const lower = char.toLowerCase(); return lower.length === char.length ? lower : char }).join('').replace(/ё/g, 'е')
  }
  each(pattern: RegExp, handler: (match: RegExpExecArray) => boolean | void) {
    for (const match of this.text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length
      if (this.spans.some(([a, b]) => start < b && end > a)) continue
      if (handler(match as RegExpExecArray) !== false) this.spans.push([start, end])
    }
  }
}

/** 1–7 without «утра/дня/вечера» are read as afternoon: «в 3» is 15:00 far more often than 03:00. */
function resolveHour(hour: number, qualifier: string | undefined, state: State, raw: string): number | null {
  if (!Number.isInteger(hour) || hour > 23) return null
  if (qualifier === 'утра') return hour === 12 ? 0 : hour
  if (qualifier === 'ночи') return hour === 12 ? 0 : hour < 5 ? hour : hour >= 9 && hour < 12 ? hour + 12 : hour
  if (qualifier === 'дня' || qualifier === 'вечера') return hour < 12 ? hour + 12 : hour
  if (hour >= 1 && hour <= 7) { state.assumptions.push(`«${raw.trim()}» понято как ${pad(hour + 12)}:00`); return hour + 12 }
  return hour
}

function today(context: ParseContext) { return localDate(context.now, context.timeZone) }
function nowClock(context: ParseContext): Clock { const wall = wallTime(context.now, context.timeZone); return { hour: wall.hour, minute: wall.minute } }
const later = (a: Clock, b: Clock) => a.hour * 60 + a.minute > b.hour * 60 + b.minute

function resolveWeekday(ref: WeekdayRef, context: ParseContext, time: Clock | null, state: State) {
  const base = today(context), current = weekday(base)
  if (ref.modifier === 'next') {
    state.assumptions.push('«следующий» понято как день на следующей неделе')
    return addDays(base, 8 - current + ref.day - 1)
  }
  let diff = (ref.day - current + 7) % 7
  if (ref.modifier === 'this' && ref.day < current) state.assumptions.push('Этот день недели уже прошёл — выбрана следующая неделя')
  if (diff === 0) {
    if (time && later(time, nowClock(context))) state.assumptions.push('Сегодня этот же день недели — запланировано на сегодня')
    else { diff = 7; state.assumptions.push('Сегодня этот же день недели — выбрана следующая неделя') }
  }
  return addDays(base, diff)
}

function dayMonth(day: number, month: number, year: number | null, context: ParseContext) {
  const base = parseDateKey(today(context))
  let candidateYear = year ?? base.year
  const valid = (y: number) => { const date = new Date(Date.UTC(y, month - 1, day)); return date.getUTCMonth() === month - 1 && date.getUTCDate() === day }
  if (!month || day < 1 || !valid(candidateYear)) return null
  const value = dateKey({ year: candidateYear, month, day })
  if (year === null && value < today(context)) { candidateYear++; if (!valid(candidateYear)) return null; return dateKey({ year: candidateYear, month, day }) }
  return value
}

function dayOfMonth(day: number, context: ParseContext, state: State) {
  const base = parseDateKey(today(context))
  for (let shift = 0; shift < 3; shift++) {
    const month = ((base.month - 1 + shift) % 12) + 1, year = base.year + Math.floor((base.month - 1 + shift) / 12)
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCDate() !== day) continue
    const value = dateKey({ year, month, day })
    if (value >= today(context)) { if (shift) state.assumptions.push(`${day}-е число в этом месяце прошло — выбран ${humanMonth(month)}`); return value }
  }
  return null
}
const humanMonth = (month: number) => ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][month - 1]

function endOfPeriod(kind: 'week' | 'next-week' | 'month' | 'year', context: ParseContext) {
  const base = today(context)
  if (kind === 'week') return addDays(base, 7 - weekday(base))
  if (kind === 'next-week') return addDays(base, 14 - weekday(base))
  const { year, month } = parseDateKey(base)
  if (kind === 'year') return `${year}-12-31`
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return dateKey({ year, month, day: last })
}

function scan(source: string, context: ParseContext): { scanner: Scanner; state: State } {
  const scanner = new Scanner(source)
  const state: State = { date: null, weekday: null, time: null, endTime: null, duration: null, deadlineDate: null, deadlineWeekday: null, deadlineTime: null, rule: null, reminder: false, kind: null, allDayHint: false, period: null, assumptions: [], vague: [], dates: 0, times: 0 }
  const setDate = (value: string | null) => { if (!value) return false; if (state.date !== value) state.dates++; state.date = value; return true }
  const setTime = (value: Clock | null) => { if (!value) return false; state.times++; state.time = value; return true }

  scanner.each(/^\s*(задача|событие)\s*:/gu, (match) => { state.kind = match[1] === 'задача' ? 'task' : 'event' })
  scanner.each(rx('напомни(?:те|ть)?(?:\\s+мне)?'), () => { state.reminder = true })

  // Recurrence
  scanner.each(rx('(?:каждый|каждое|каждую)\\s+(будний\\s+)?день|ежедневно'), (match) => { state.rule = match[1] ? { freq: 'WEEKLY', interval: 1, byDay: icalDays.slice(0, 5), byMonthDay: null } : { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: null } })
  scanner.each(rx('по\\s+будням'), () => { state.rule = { freq: 'WEEKLY', interval: 1, byDay: icalDays.slice(0, 5), byMonthDay: null } })
  scanner.each(rx('по\\s+выходным'), () => { state.rule = { freq: 'WEEKLY', interval: 1, byDay: ['SA', 'SU'], byMonthDay: null } })
  scanner.each(rx(`(?:каждый|каждую|каждое|по)\\s+${WEEKDAY}(?:\\s*(?:,|и)\\s*${WEEKDAY})*`), (match) => {
    const days = [...match[0].matchAll(new RegExp(WEEKDAY, 'gu'))].map((item) => weekdayOf(item[0])).filter((day) => day > 0)
    state.rule = { freq: 'WEEKLY', interval: 1, byDay: [...new Set(days)].sort().map((day) => icalDays[day - 1]), byMonthDay: null }
  })
  scanner.each(rx('(?:каждое|каждого)\\s+(\\d{1,2})(?:-?е|-?го)?\\s+числ[оа]|(\\d{1,2})(?:-?го)?\\s+числа\\s+каждого\\s+месяца'), (match) => {
    const day = Number(match[1] || match[2])
    if (day < 1 || day > 31) return false
    state.rule = { freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: day }
  })
  scanner.each(rx('(?:каждые|раз\\s+в)\\s+(\\d+|два|две|три|четыре)\\s+(дн[яей]+|недел[иьюя]|месяц[аев]*)'), (match) => {
    const interval = toNumber(match[1])
    if (!interval || interval > 52) return false
    state.rule = { freq: match[2].startsWith('дн') ? 'DAILY' : match[2].startsWith('нед') ? 'WEEKLY' : 'MONTHLY', interval, byDay: [], byMonthDay: null }
  })
  scanner.each(rx('каждую\\s+неделю|еженедельно|раз\\s+в\\s+неделю'), () => { state.rule = { freq: 'WEEKLY', interval: 1, byDay: [], byMonthDay: null } })
  scanner.each(rx('каждый\\s+месяц|ежемесячно|раз\\s+в\\s+месяц'), () => { state.rule = { freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: null } })
  scanner.each(rx('каждый\\s+год|ежегодно|раз\\s+в\\s+год'), () => { state.rule = { freq: 'YEARLY', interval: 1, byDay: [], byMonthDay: null } })

  // Time ranges come before deadlines: «с 14 до 16» is a range, not a deadline.
  const TIME = `(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*(?:час(?:а|ов)?))?(?:\\s+${QUALIFIER})?`
  scanner.each(rx(`(?:(?:в|во)\\s+)?(?:промежутке\\s+)?с\\s+${TIME}\\s+(?:до|по)\\s+${TIME}`), (match) => {
    const [h1, m1, q1, h2, m2, q2] = match.slice(1)
    const assumptions = state.assumptions.length
    const start = resolveHour(Number(h1), q1 || (q2 && Number(h1) <= Number(h2) ? q2 : undefined), state, `с ${h1}`)
    let end = resolveHour(Number(h2), q2, state, `до ${h2}`)
    if (start === null || end === null || Number(m1 || 0) > 59 || Number(m2 || 0) > 59) { state.assumptions.length = assumptions; return false }
    if (end < start && end + 12 <= 23 && !q2) end += 12
    setTime({ hour: start, minute: Number(m1 || 0) })
    state.endTime = { hour: end, minute: Number(m2 || 0) }
  })
  scanner.each(rx('(\\d{1,2})[:.](\\d{2})\\s*[-–—]\\s*(\\d{1,2})[:.](\\d{2})'), (match) => {
    const [h1, m1, h2, m2] = match.slice(1).map(Number)
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return false
    setTime({ hour: h1, minute: m1 })
    state.endTime = { hour: h2, minute: m2 }
  })

  // Deadlines
  scanner.each(rx(`${DEADLINE}\\s+(?:(следующ\\S*|эт\\S*|ближайш\\S*)\\s+)?${WEEKDAY}`), (match) => {
    state.deadlineWeekday = { day: weekdayOf(match[2]), modifier: match[1]?.startsWith('след') ? 'next' : match[1]?.startsWith('эт') ? 'this' : null }
  })
  scanner.each(rx(`${DEADLINE}\\s+(\\d{1,2})(?:-?го|-?е)?\\s+${MONTH}(?:\\s+(\\d{4})(?:\\s*г(?:ода|\\.)?)?)?`), (match) => {
    state.deadlineDate = dayMonth(Number(match[1]), monthOf(match[2]), match[3] ? Number(match[3]) : null, context)
    return Boolean(state.deadlineDate)
  })
  scanner.each(rx(`${DEADLINE}\\s+(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?`), (match) => {
    const month = Number(match[2])
    if (month > 12 || month < 1) return false
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : null
    state.deadlineDate = dayMonth(Number(match[1]), month, year, context)
    return Boolean(state.deadlineDate)
  })
  scanner.each(rx(`${DEADLINE}\\s+(\\d{1,2})(?:-?го|-?е|\\s+числа)`), (match) => {
    state.deadlineDate = dayOfMonth(Number(match[1]), context, state)
    return Boolean(state.deadlineDate)
  })
  scanner.each(rx(`${DEADLINE}\\s+(сегодня|завтра|послезавтра|завтрашнего\\s+дня|завтрашнему\\s+дню)`), (match) => {
    state.deadlineDate = addDays(today(context), match[1].startsWith('сегодня') ? 0 : match[1].startsWith('послезавтра') ? 2 : 1)
  })
  scanner.each(rx(`${DEADLINE}\\s+конц[ауе]\\s+(недели|месяца|года|дня)`), (match) => {
    state.deadlineDate = match[1] === 'дня' ? today(context) : endOfPeriod(match[1] === 'недели' ? 'week' : match[1] === 'месяца' ? 'month' : 'year', context)
  })
  scanner.each(rx(`до\\s+(\\d{1,2})[:.](\\d{2})|до\\s+${NUM}\\s*(?:час(?:а|ов)?\\s+)?${QUALIFIER}`), (match) => {
    if (match[1]) {
      const hour = Number(match[1]), minute = Number(match[2])
      if (hour > 23 || minute > 59) return false
      state.deadlineTime = { hour, minute }
    } else {
      const hour = resolveHour(toNumber(match[3]), match[4], state, match[0])
      if (hour === null) return false
      state.deadlineTime = { hour, minute: 0 }
    }
  })
  scanner.each(rx('(?:до|к)\\s+(вечера|вечеру|обеда|обеду)'), (match) => {
    state.deadlineTime = match[1].startsWith('веч') ? { hour: 18, minute: 0 } : { hour: 13, minute: 0 }
    state.assumptions.push(`«${match[0]}» понято как ${match[1].startsWith('веч') ? '18:00' : '13:00'}`)
  })

  // Dates
  scanner.each(rx('(\\d{4})-(\\d{2})-(\\d{2})'), (match) => setDate(dayMonth(Number(match[3]), Number(match[2]), Number(match[1]), context)))
  scanner.each(rx(`(?:(?:на|в)\\s+)?(\\d{1,2})(?:-?го|-?е)?\\s+${MONTH}(?:\\s+(\\d{4})(?:\\s*г(?:ода|\\.)?)?)?`), (match) => setDate(dayMonth(Number(match[1]), monthOf(match[2]), match[3] ? Number(match[3]) : null, context)))
  scanner.each(rx('(в\\s+|на\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?'), (match) => {
    const month = Number(match[3])
    // «в 15.30» is a time; «на 15.10» and «15.10» are dates.
    if (month > 12 || month < 1 || (match[1]?.startsWith('в') && !match[4] && match[3].length === 2 && Number(match[2]) <= 23)) return false
    const year = match[4] ? Number(match[4].length === 2 ? `20${match[4]}` : match[4]) : null
    return setDate(dayMonth(Number(match[2]), month, year, context))
  })
  scanner.each(rx('(?:(?:на|в)\\s+)?(\\d{1,2})(?:-?го|\\s+числа)'), (match) => setDate(dayOfMonth(Number(match[1]), context, state)))
  scanner.each(rx('(?:на\\s+)?(сегодня|завтра|послезавтра)(?:\\s+(утром|днем|вечером|ночью))?'), (match) => {
    setDate(addDays(today(context), match[1] === 'сегодня' ? 0 : match[1] === 'завтра' ? 1 : 2))
    if (match[2] && !state.time) { state.time = partOfDay[match[2]]; state.assumptions.push(`«${match[2]}» понято как ${pad(state.time.hour)}:00`) }
  })
  scanner.each(rx(`через\\s+(?:(${NUM.slice(1, -1)}|\\d+)\\s+)?(минут[уы]?|мин|час(?:а|ов)?|полчаса|полтора\\s+часа|дн(?:я|ей)|день|сутки|недел[июь]|месяц(?:а|ев)?|год)`), (match) => {
    const count = match[1] ? toNumber(match[1]) : 1
    const unit = match[2]
    if (!count || count > 365) return false
    if (/^(мин|час|пол)/.test(unit)) {
      const minutes = unit === 'полчаса' ? 30 : unit.startsWith('полтора') ? 90 : unit.startsWith('мин') ? count : count * 60
      const at = new Date(Math.ceil((context.now.getTime() + minutes * 60000) / 60000) * 60000)
      setDate(localDate(at, context.timeZone))
      const [hour, minute] = localTime(at, context.timeZone).split(':').map(Number)
      setTime({ hour, minute })
      return
    }
    const days = unit.startsWith('нед') ? count * 7 : unit.startsWith('мес') ? count * 30 : unit === 'год' ? 365 : count
    if (unit.startsWith('мес')) state.assumptions.push(`«${match[0]}» понято как ${days} дней`)
    setDate(addDays(today(context), days))
  })
  scanner.each(rx(`(?:(?:в|во|на)\\s+)?(?:(следующ\\S*|эт\\S*|ближайш\\S*)\\s+)?${WEEKDAY}`), (match) => {
    if (/ам$/.test(match[2])) return false
    state.weekday = { day: weekdayOf(match[2]), modifier: match[1]?.startsWith('след') ? 'next' : match[1]?.startsWith('эт') ? 'this' : null }
    state.dates++
  })
  scanner.each(rx('(?:на|в)\\s+(?:эти\\s+|ближайшие\\s+)?выходные|на\\s+выходных'), () => {
    state.weekday = { day: 6, modifier: null }
    state.dates++
    state.assumptions.push('«выходные» понято как суббота')
  })

  // Times
  scanner.each(rx('в\\s+полдень'), () => setTime({ hour: 12, minute: 0 }))
  scanner.each(rx(`(?:(?:в|во|около|примерно\\s+в|к)\\s+)?(\\d{1,2})[:.](\\d{2})(?:\\s+${QUALIFIER})?`), (match) => {
    const minute = Number(match[2])
    const hour = match[3] ? resolveHour(Number(match[1]), match[3], state, match[0]) : Number(match[1])
    if (hour === null || hour > 23 || minute > 59) return false
    return setTime({ hour, minute })
  })
  scanner.each(new RegExp(`${L}(?:(?:в|во|около|примерно\\s+в|к)\\s+)${NUM}(?:\\s*(?:час(?:а|ов)?|ч))?(?:\\s+${QUALIFIER})?${R}(?!\\s*(?:минут|мин|раз|год|недел|дн|человек|%|кабинет|аудитори|этаж|класс|корпус))`, 'gu'), (match) => {
    const hour = resolveHour(toNumber(match[1]), match[2], state, match[0])
    return hour === null ? false : setTime({ hour, minute: 0 })
  })
  scanner.each(rx(`${NUM}\\s+${QUALIFIER}`), (match) => {
    const hour = resolveHour(toNumber(match[1]), match[2], state, match[0])
    return hour === null ? false : setTime({ hour, minute: 0 })
  })

  // Durations
  scanner.each(rx('(?:на|в\\s+течение)\\s+(полчаса|полтора\\s+часа|час|сутки)'), (match) => { state.duration = { полчаса: 30, час: 60, сутки: 1440 }[match[1]] ?? 90 })
  scanner.each(rx(`(?:(?:на|в\\s+течение|длительностью)\\s+)?(\\d+(?:[.,]\\d)?|${NUM.slice(1, -1)})\\s*(минут[уы]?|мин|час(?:а|ов)?|ч)`), (match) => {
    const value = toNumber(match[1]) || Number(match[1].replace(',', '.'))
    const minutes = Math.round(match[2].startsWith('м') ? value : value * 60)
    if (!minutes || minutes > 1440) return false
    state.duration = minutes
  })
  scanner.each(rx('(?:на\\s+)?весь\\s+день'), () => { state.allDayHint = true })

  // Parts of the day and vague periods
  scanner.each(rx('утром|с\\s+утра|днем|в\\s+обед|после\\s+обеда|вечером|ночью'), (match) => {
    const key = match[0].replace(/\s+/g, ' ')
    if (!state.time) { state.time = partOfDay[key]; state.assumptions.push(`«${key}» понято как ${pad(state.time.hour)}:00`) }
  })
  scanner.each(rx('на\\s+этой\\s+неделе|на\\s+следующей\\s+неделе|в\\s+этом\\s+месяце'), (match) => {
    state.period = { kind: match[0].includes('следующ') ? 'next-week' : match[0].includes('месяц') ? 'month' : 'week', label: match[0] }
  })
  scanner.each(rx('скоро|на\\s+днях|как-нибудь|когда-нибудь|когда\\s+будет\\s+время|позже|потом'), (match) => { state.vague.push(match[0]) })
  return { scanner, state }
}

function cleanTitle(source: string, spans: [number, number][]) {
  let text = ''
  let cursor = 0
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) { text += `${source.slice(cursor, start)} `; cursor = end }
  text += source.slice(cursor)
  const filler = /^\s*(?:пожалуйста\s+)?(?:нужно|надо|необходимо|не\s+забыть|запланируй(?:те)?|запланировать|добавь(?:те)?|добавить|создай(?:те)?|создать|поставь(?:те)?|поставить|запиши(?:те)?|записать)(?:\s+мне)?(?:\s+(?:что|о|об|про))?\s+/iu
  for (let index = 0; index < 3; index++) text = text.replace(filler, '')
  text = text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=[,;:.])/g, '')
  const edge = /(?:^|\s)(?:в|во|на|до|к|ко|с|со|и|а|по|около|примерно|где-то|в\s+течение|,|-|–|—)\s*$/iu
  for (let index = 0; index < 4; index++) text = text.trim().replace(edge, '').replace(/^(?:и|а|,|-|–|—)\s+/iu, '').replace(/^[,.;:\s]+|[,;:\s]+$/g, '')
  text = text.trim()
  return text ? text[0].toLocaleUpperCase('ru') + text.slice(1) : ''
}

function ruleString(rule: RuleParts) {
  return [`FREQ=${rule.freq}`, rule.interval > 1 ? `INTERVAL=${rule.interval}` : '', rule.byDay.length ? `BYDAY=${rule.byDay.join(',')}` : '', rule.byMonthDay ? `BYMONTHDAY=${rule.byMonthDay}` : ''].filter(Boolean).join(';')
}

/** First date ≥ today that matches the rule; today only when the time has not passed yet. */
function firstOccurrence(rule: RuleParts, context: ParseContext, time: Clock | null) {
  const base = today(context)
  const allowToday = !time || later(time, nowClock(context))
  for (let shift = allowToday ? 0 : 1; shift < 400; shift++) {
    const date = addDays(base, shift)
    if (rule.byDay.length && !rule.byDay.includes(icalDays[weekday(date) - 1])) continue
    if (rule.byMonthDay && parseDateKey(date).day !== rule.byMonthDay) continue
    return date
  }
  return base
}

export function parseItem(source: string, context: ParseContext): ParsedItem {
  const { scanner, state } = scan(source, context)
  const title = cleanTitle(source, scanner.spans)
  const normalizedTitle = title.toLocaleLowerCase('ru').replace(/ё/g, 'е')
  const lowered = scanner.text
  const assumptions = state.assumptions
  const missing: string[] = []
  const time = state.time
  const hasDeadline = Boolean(state.deadlineDate || state.deadlineWeekday || state.deadlineTime)
  const isEventWord = eventWords.test(lowered)
  let kind: 'event' | 'task' = state.kind
    ?? (hasDeadline || state.reminder ? 'task'
      : time || state.endTime ? (taskVerbs.test(normalizedTitle) && !isEventWord ? 'task' : 'event')
        : isEventWord && (state.date || state.weekday || state.rule || state.period) ? 'event' : 'task')
  if (state.rule && kind === 'task' && !hasDeadline && (time || isEventWord)) kind = 'event'

  let date = state.date ?? (state.weekday ? resolveWeekday(state.weekday, context, time, state) : null)
  const rrule = state.rule ? ruleString({ ...state.rule, byDay: state.rule.byDay.length || state.rule.freq !== 'WEEKLY' || !date ? state.rule.byDay : [icalDays[weekday(date) - 1]] }) : null
  if (state.rule && !date) date = firstOccurrence(state.rule, context, time)
  const recognized = Boolean(date || time || hasDeadline || state.rule || state.period)
  const base: ParsedItem = { kind, title, assumptions, missing, vague: state.vague, compound: state.dates > 1 || state.times > 1, recognized, rrule }

  if (kind === 'event') {
    if (!date && time) {
      date = today(context)
      if (!later(time, nowClock(context))) { date = addDays(date, 1); assumptions.push('Это время сегодня уже прошло — запланировано на завтра') }
    }
    if (!date) { missing.push(state.period ? `день («${state.period.label}» — какой именно?)` : 'дата'); if (!time) missing.push('время'); return base }
    if (!time) {
      if (allDayWords.test(lowered) || state.allDayHint) {
        const days = state.duration && state.duration >= 1440 ? Math.round(state.duration / 1440) : 1
        return { ...base, start: date, end: addDays(date, days), allDay: true }
      }
      missing.push('время')
      return { ...base, start: date, allDay: false }
    }
    const start = atLocalTime(date, `${pad(time.hour)}:${pad(time.minute)}`, context.timeZone)
    let end: Date
    if (state.endTime) {
      end = atLocalTime(date, `${pad(state.endTime.hour)}:${pad(state.endTime.minute)}`, context.timeZone)
      if (end <= start) end = atLocalTime(addDays(date, 1), `${pad(state.endTime.hour)}:${pad(state.endTime.minute)}`, context.timeZone)
    } else {
      if (!state.duration) assumptions.push('Длительность не указана — 1 час')
      end = new Date(start.getTime() + (state.duration || 60) * 60000)
    }
    return { ...base, start: start.toISOString(), end: end.toISOString(), allDay: false, durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000) }
  }

  // Task: a deadline wins over a plain date; a lone time attaches to the deadline day.
  let dueDate = state.deadlineDate ?? (state.deadlineWeekday ? resolveWeekday(state.deadlineWeekday, context, state.deadlineTime, state) : null)
  let dueTime = state.deadlineTime ?? time
  if (!dueDate) dueDate = date
  if (!dueDate && state.period) { dueDate = endOfPeriod(state.period.kind, context); assumptions.push(`«${state.period.label}» понято как срок до ${dueDate.split('-').reverse().slice(0, 2).join('.')}`) }
  if (!dueDate && dueTime) {
    dueDate = today(context)
    if (!later(dueTime, nowClock(context))) { dueDate = addDays(dueDate, 1); assumptions.push('Это время сегодня уже прошло — срок перенесён на завтра') }
  }
  if (state.reminder && !dueTime && dueDate) { missing.push('время напоминания'); dueTime = null }
  if (state.reminder && !dueDate) missing.push('когда напомнить')
  const due = dueDate ? (dueTime ? atLocalTime(dueDate, `${pad(dueTime.hour)}:${pad(dueTime.minute)}`, context.timeZone).toISOString() : dueDate) : null
  if (due && dueDate && daysBetween(today(context), dueDate) < 0) assumptions.push('Срок в прошлом — проверьте дату')
  return { ...base, due, dueHasTime: Boolean(due && dueTime), durationMinutes: state.duration, reminderMinutes: state.reminder && dueTime ? 0 : null }
}

/** Split a message into separate requests on unambiguous separators only. */
export function splitRequests(text: string) {
  return text.split(/\n+|;\s*|,\s*а\s+(?:также\s+|еще\s+|ещё\s+|потом\s+)?|\s+а\s+(?:также|еще|ещё|потом)\s+/u).map((part) => part.trim()).filter((part) => part.length > 1)
}
