import type { TrendConversation } from '../../../shared/trend-chat.js'
import type { TrendDomain } from '../../../shared/trends.js'
export type ChatCommand = { calls: { name: string; arguments: unknown }[]; reply: 'help' | 'brief' | 'research' | 'sources' | 'inspect' | 'history' | 'saved' | 'bookmark' | 'compare' | 'thanks'; question?: string }
const call = (name: string, args: unknown = {}) => ({ name, arguments: args })
const domains: Record<string, TrendDomain> = { все: 'all', финансы: 'finance', здоровье: 'health', спорт: 'health', гардероб: 'wardrobe', дела: 'planning', all: 'all', finance: 'finance', health: 'health', wardrobe: 'wardrobe', planning: 'planning' }
function selected(conversation: TrendConversation, value: string) {
  const index = Number(value) - 1
  return Number.isInteger(index) && index >= 0 ? conversation.sourceSelection[index] : undefined
}
/** A deliberately small grammar: unsupported language goes to the model, never guessed silently. */
export function parseChatCommand(raw: string, conversation: TrendConversation): ChatCommand | null {
  const text = raw.trim(), lower = text.toLocaleLowerCase()
  if (/^(?:привет|здравствуйте|добрый день|\/помощь|\/help)[!. ]*$/u.test(lower)) return { calls: [], reply: 'help' }
  if (/^спасибо[!. ]*$/u.test(lower)) return { calls: [], reply: 'thanks' }
  let match = text.match(/^(?:\/тема|тема:)\s+(.+)$/iu)
  if (match) return { calls: [call('update_brief', { query: match[1].trim() })], reply: 'brief' }
  match = text.match(/^(?:\/период\s+|за\s+)(\d+)(?:\s*(?:день|дня|дней))?$/iu)
  if (match) return { calls: [call('update_brief', { windowDays: Number(match[1]) })], reply: 'brief' }
  if (['за неделю', 'за месяц', 'за две недели'].includes(lower)) return { calls: [call('update_brief', { windowDays: lower === 'за месяц' ? 30 : lower === 'за две недели' ? 14 : 7 })], reply: 'brief' }
  match = text.match(/^\/область\s+(.+)$/iu)
  if (match) return { calls: domains[match[1].toLocaleLowerCase()] ? [call('update_brief', { domain: domains[match[1].toLocaleLowerCase()] })] : [], reply: 'brief', ...(domains[match[1].toLocaleLowerCase()] ? {} : { question: 'Выберите область: все, финансы, здоровье, гардероб или дела.' }) }
  match = text.match(/^(?:\/найти|найди|поищи|исследуй)\s*(.*)$/iu)
  if (match || /^обнови (?:поиск|материалы|исследование)$/iu.test(text)) {
    let topic = (match?.[1] || '').replace(/^тренды(?:\s+(?:по|в|про))?\s*/iu, '').trim()
    const period = topic.match(/\s+за\s+(\d+)\s*(?:день|дня|дней)\s*$/iu)
    const windowDays = period ? Number(period[1]) : undefined
    if (period) topic = topic.slice(0, period.index).trim()
    const calls = topic || windowDays ? [call('update_brief', { ...(topic ? { query: topic } : {}), ...(windowDays ? { windowDays } : {}) })] : []
    if (!topic && !conversation.brief.query) return { calls: [], reply: 'research', question: 'Какую тему исследуем? Например: «Найди силовые тренировки за 14 дней».' }
    return { calls: [...calls, call('research_now')], reply: 'research' }
  }
  if (/^(?:\/источники|покажи (?:все )?источники|только прочитанные|только с датой|только свежие|только научные)$/iu.test(text)) {
    const filters = lower === 'только прочитанные' ? { onlyRead: true } : lower === 'только с датой' ? { onlyDated: true } : lower === 'только свежие' ? { onlyRecent: true } : lower === 'только научные' ? { kind: 'paper' } : { reset: true }
    return { calls: [call('filter_sources', filters)], reply: 'sources' }
  }
  match = text.match(/^\/(?:история)(?:\s+(.+))?$/iu)
  if (match || lower === 'покажи прошлые исследования') return { calls: [call('list_reports', { query: match?.[1] || '' })], reply: 'history' }
  if (/^(?:\/закладки|покажи закладки|покажи сохранённое|покажи сохраненное)$/iu.test(text)) return { calls: [call('list_saved_sources')], reply: 'saved' }
  match = text.match(/^(?:\/источник|расскажи про источник)\s+(\d+)$/iu)
  if (match) { const source = selected(conversation, match[1]); return source ? { calls: [call('inspect_source', { sourceId: source.id, reportId: source.reportId })], reply: 'inspect' } : { calls: [], reply: 'inspect', question: 'Сначала покажите источники, затем укажите номер из текущего списка.' } }
  match = text.match(/^(?:\/сохранить|сохрани(?: источник)?)\s+(\d+)$/iu)
  if (match) { const source = selected(conversation, match[1]); return source ? { calls: [call('save_source', { sourceId: source.id, reportId: source.reportId })], reply: 'bookmark' } : { calls: [], reply: 'bookmark', question: 'Какой источник сохранить? Сначала покажите источники и укажите номер.' } }
  match = text.match(/^\/сравнить\s+(\d+)\s+(\d+)$/iu)
  if (match) {
    const leftId = conversation.reportSelection[Number(match[1]) - 1], rightId = conversation.reportSelection[Number(match[2]) - 1]
    return leftId && rightId ? { calls: [call('compare_reports', { leftId, rightId })], reply: 'compare' } : { calls: [], reply: 'compare', question: 'Сначала откройте /история и укажите два номера отчётов из списка.' }
  }
  match = text.match(/^\/сравнить\s+([a-f0-9-]{36})\s+([a-f0-9-]{36})$/iu)
  if (match) return { calls: [call('compare_reports', { leftId: match[1], rightId: match[2] })], reply: 'compare' }
  return null
}
