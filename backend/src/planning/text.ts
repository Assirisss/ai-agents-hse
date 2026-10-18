import type { DraftItem, PlanningDraft } from '../../../shared/planning.js'
import { humanDate, isDateKey, localDate, localTime } from './time.js'

/** Plain-text rendering of drafts shared by Telegram and the assistant. */
const dayNames: Record<string, string> = { MO: 'пн', TU: 'вт', WE: 'ср', TH: 'чт', FR: 'пт', SA: 'сб', SU: 'вс' }
export function ruleText(rrule: string | null | undefined) {
  if (!rrule) return ''
  const parts = Object.fromEntries(rrule.split(';').map((part) => part.split('=')))
  const every = Number(parts.INTERVAL || 1) > 1 ? `каждые ${parts.INTERVAL} ` : ''
  if (parts.FREQ === 'DAILY') return every ? `${every}дн.` : 'каждый день'
  if (parts.FREQ === 'WEEKLY') return parts.BYDAY === 'MO,TU,WE,TH,FR' ? 'по будням' : parts.BYDAY ? `${every ? `${every}нед.: ` : 'по '}${parts.BYDAY.split(',').map((day: string) => dayNames[day] || day).join(', ')}` : every ? `${every}нед.` : 'каждую неделю'
  if (parts.FREQ === 'MONTHLY') return parts.BYMONTHDAY ? `ежемесячно ${parts.BYMONTHDAY}-го` : every ? `${every}мес.` : 'ежемесячно'
  if (parts.FREQ === 'YEARLY') return 'ежегодно'
  return 'повторяется'
}

export function describeItem(item: DraftItem, timeZone: string) {
  const lines: string[] = []
  if (item.kind === 'event') {
    let when = 'дата не определена'
    if (item.start && item.allDay) when = `${humanDate(item.start)}, весь день`
    else if (item.start && isDateKey(item.start)) when = `${humanDate(item.start)}, время не указано`
    else if (item.start && item.end) when = `${humanDate(localDate(new Date(item.start), timeZone))}, ${localTime(new Date(item.start), timeZone)}–${localTime(new Date(item.end), timeZone)}`
    lines.push(`📅 Событие: ${item.title || 'без названия'}`, `   ${when}${item.rrule ? ` · ${ruleText(item.rrule)}` : ''}`)
    for (const conflict of item.conflicts) lines.push(`   ⚠ пересекается: ${conflict.allDay ? '' : `${localTime(new Date(conflict.start), timeZone)} `}${conflict.title}`)
  } else {
    const due = !item.due ? 'без срока' : item.dueHasTime ? `срок ${humanDate(localDate(new Date(item.due), timeZone))}, ${localTime(new Date(item.due), timeZone)}` : `срок ${humanDate(item.due)}`
    lines.push(`☐ Задача: ${item.title || 'без названия'}`, `   ${due}${item.rrule ? ` · ${ruleText(item.rrule)}` : ''}${item.reminderMinutes === 0 ? ' · напомню в это время' : ''}`)
  }
  if (item.missing.length) lines.push(`   ❓ не хватает: ${item.missing.join(', ')}`)
  return lines.join('\n')
}

export function draftText(draft: PlanningDraft, timeZone: string) {
  const method = { parser: 'правила', ai: 'модель + правила для дат', 'parser+ai': 'правила и модель', agent: 'агент, время проверено кодом' }[draft.method]
  const lines = [`Понял так (${method}):`, '', ...draft.items.map((item, index) => `${draft.items.length > 1 ? `${index + 1}. ` : ''}${describeItem(item, timeZone)}`)]
  const assumptions = [...new Set(draft.items.flatMap((item) => item.assumptions))]
  if (assumptions.length) lines.push('', `Допущения: ${assumptions.join('; ')}.`)
  if (draft.question) lines.push('', `❓ ${draft.question}`)
  return lines.join('\n')
}
