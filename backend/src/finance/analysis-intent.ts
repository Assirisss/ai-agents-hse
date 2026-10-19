import type { Account, Category, FinanceAnalysisKind, FinanceAnalysisRequest, OperationFilter } from '../../../shared/finance.js'
import { analysisPeriods, analysisRequestSchema, shiftDate } from './analysis.js'
import { dateSchema, moscowToday } from './schema.js'

export function analysisIntent(raw: string): Exclude<FinanceAnalysisKind, 'breakdown'> | undefined {
  const text = raw.trim().replace(/^\/finance(?:@\w+)?\s+/iu, '')
  if (text.startsWith('/')) return undefined
  if (/что\s+(?:будет|изменится)[\s\S]*если|сценари[йя]|(?:сократ|уменьш|сниз)[\s\S]*(?:%|процент)/iu.test(text)) return 'scenario'
  if (/подписк|регулярн[а-яё]*\s+(?:плат|расход|списан)|постоянн[а-яё]*\s+(?:расход|плат)/iu.test(text)) return 'recurring'
  if (/необычн|подозрительн|аномал|дубликат|странн[а-яё]*\s+(?:трат|расход|списан)/iu.test(text)) return 'unusual'
  if (/(?:как[\s\S]*прошл|итог|сводк|отч[её]т)[\s\S]*недел|недельн[а-яё]*\s+(?:сводк|отч[её]т|итог)/iu.test(text)) return 'weekly'
  if (/(?:почему|за\s+сч[её]т\s+чего|объясни|разбери|проанализируй|сравни)[\s\S]*(?:расход|трат|списан|деньг)|(?:расход|трат)[\s\S]*(?:почему|измен|вырос|увелич|снизил|уменьшил)/iu.test(text)) return 'changes'
  return undefined
}
const normalize = (text: string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
function matches<T extends Account | Category>(text: string, items: T[]) {
  const tokens = normalize(text).split(/[^\p{L}\p{N}]+/u)
  return items.filter(item => {
    if (normalize(text).includes(item.id.toLowerCase()) && item.id.length > 3) return true
    const words = normalize(item.name).split(/\s+/)
    return words.every(word => {
      const stem = word.length > 3 ? word.replace(/(?:ыми|ими|ый|ой|ий|ая|яя|ое|ее|ые|ие|а|я|ь|ы|и)$/u, '') : word
      return tokens.some(token => token.startsWith(stem))
    })
  })
}

export type AnalysisResolution = { request: FinanceAnalysisRequest; limitations?: string[]; question?: never } | { question: string; request?: never }
/** Resolve explicit scope before a model sees tools; ambiguous parameters never silently become all expenses. */
export function resolveAnalysisRequest(text: string, kind: Exclude<FinanceAnalysisKind, 'breakdown'>, accounts: Account[], categories: Category[], now: Date, previous: OperationFilter = {}): AnalysisResolution {
  const today = moscowToday(now), source = normalize(text), limitations: string[] = []
  const carry = /эти[хм]?\s+(?:расход|трат)|этой\s+категор|этом\s+счет|том\s+же|той\s+же|а\s+теперь|только\s+по|сократ[а-я]*\s+их/iu.test(source) ? previous : {}
  const request: FinanceAnalysisRequest = { kind, ...(carry.accountId ? { accountId: carry.accountId } : {}), ...(carry.categoryId ? { categoryId: carry.categoryId } : {}), ...(carry.query ? { query: carry.query } : {}) }
  const foundAccounts = matches(text, accounts), foundCategories = matches(text, categories.filter(item => item.kind === 'expense'))
  if (foundAccounts.length > 1 || foundCategories.length > 1) return { question: 'Уточните один счёт и одну категорию для анализа либо явно укажите «все счета» и «все категории».' }
  if (/все\s+счета|всем\s+счетам/iu.test(source)) delete request.accountId
  else if (foundAccounts[0]) request.accountId = foundAccounts[0].id
  else if (/(?:^|[^а-яё])(?:карт[а-яё]*|счет(?:а|у|е|ом)?)(?:$|[^а-яё])/u.test(source)) return { question: `Какой счёт использовать? Доступны: ${accounts.map(item => item.name).join(', ')}.` }
  if (/все\s+категории|всем\s+категориям/iu.test(source)) delete request.categoryId
  else if (foundCategories[0]) { request.categoryId = foundCategories[0].id; delete request.query }

  const dates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(item => item[0])
  if (dates.length) {
    if (![1, 2, ...(kind === 'changes' ? [4] : [])].includes(dates.length) || dates.some(date => !dateSchema.safeParse(date).success) || dates[0]! > (dates[1] || dates[0]!)) return { question: 'Укажите период двумя существующими датами: YYYY-MM-DD YYYY-MM-DD.' }
    if (dates.length === 4) {
      const ranges = [{ from: dates[0]!, to: dates[1]! }, { from: dates[2]!, to: dates[3]! }].sort((a, b) => a.from.localeCompare(b.from))
      request.previousFrom = ranges[0]!.from; request.previousTo = ranges[0]!.to; request.from = ranges[1]!.from; request.to = ranges[1]!.to
    } else { request.from = dates[0]; request.to = dates[1] || dates[0] }
  } else if (/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|(?:за|с|по)\s+\d{1,2}[./]\d{1,2}(?![\d%])|январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр/iu.test(source)) return { question: 'Для этого периода укажите начало и конец в формате YYYY-MM-DD YYYY-MM-DD.' }
  else if (/(?:прошл|предыдущ)[а-я]*\s+месяц/u.test(source)) {
    const last = shiftDate(`${today.slice(0, 7)}-01`, -1)
    request.from = `${last.slice(0, 7)}-01`; request.to = last
    if (kind === 'changes') {
      const previousLast = shiftDate(request.from, -1), count = Math.min(Number(last.slice(8)), Number(previousLast.slice(8)))
      request.to = shiftDate(request.from, count - 1)
      if (request.to !== last) limitations.push(`Для одинаковой длительности взяты первые ${count} дней месяцев; конец выбранного месяца ${shiftDate(request.to, 1)} — ${last} не включён.`)
      request.previousFrom = `${previousLast.slice(0, 7)}-01`; request.previousTo = shiftDate(request.previousFrom, count - 1)
    }
  } else if (/(?:эт|текущ)[а-я]*\s+месяц/u.test(source)) {
    if (kind !== 'changes') { request.from = `${today.slice(0, 7)}-01`; request.to = today }
  } else if (/(?:прошл|предыдущ)[а-я]*\s+недел/u.test(source)) {
    const monday = shiftDate(today, 1 - (new Date(`${today}T12:00:00Z`).getUTCDay() || 7))
    request.from = shiftDate(monday, -7); request.to = shiftDate(monday, -1)
  } else if (/(?:эт|текущ)[а-я]*\s+недел/u.test(source)) {
    request.from = shiftDate(today, 1 - (new Date(`${today}T12:00:00Z`).getUTCDay() || 7)); request.to = today
  } else {
    const days = /(?:последни[ех]|за)\s+(\d{1,3})\s+дн/iu.exec(source)
    if (days) { const count = Number(days[1]); if (count < 1 || count > 366) return { question: 'Выберите период от 1 до 366 дней.' }; request.from = shiftDate(today, 1 - count); request.to = today }
    else if (/за\s+(?:год|все|весь)|позапрошл/u.test(source)) return { question: 'Уточните период анализа двумя датами; доступно до 366 дней за один запрос.' }
  }
  if (kind === 'scenario') {
    const percentages = [...text.matchAll(/([-−]?\d+(?:[.,]\d+)?)\s*(?:%|процент)/giu)].map(item => Number(item[1]!.replace(',', '.').replace('−', '-')))
    if (percentages.length !== 1 || percentages[0]! < 0 || percentages[0]! > 100 || Number(percentages[0]!.toFixed(2)) !== percentages[0]) return { question: 'На сколько процентов сократить выбранные расходы? Укажите один процент от 0 до 100, например 20%.' }
    request.reductionPercent = percentages[0]
    if (!foundCategories.length) {
      const topic = /(?:сократ[а-яё]*|уменьш[а-яё]*|сниз[а-яё]*)\s+(.+?)\s+на\s+\d/iu.exec(text)?.[1]?.replace(/^(?:траты|расходы)\s+на\s+/iu, '').trim()
      if (topic && !/^(?:траты|расходы|их|это|все)$/iu.test(topic)) {
        const query = normalize(topic).replace(/(?:ку|ки|ке|а|у|ы|е)$/u, match => match.startsWith('к') ? 'к' : '')
        if (query.length >= 3 && query.length <= 200) { request.query = query; delete request.categoryId }
      }
      if (!request.categoryId && !request.query) return { question: `Какие расходы сократить? Укажите категорию (${categories.filter(item => item.kind === 'expense').map(item => item.name).join(', ')}) либо описание, например «сократить доставку на 20%».` }
    }
  }
  // Materialize defaults once. Tools are locked to this period for the whole agent run.
  const parsed = analysisRequestSchema.safeParse(request)
  if (!parsed.success) return { question: parsed.error.issues[0]?.message || 'Уточните параметры анализа.' }
  if (request.to && request.to > today) return { question: 'Выберите период по сегодняшний день. Будущие операции в анализ не входят.' }
  analysisPeriods(parsed.data, today)
  return { request: parsed.data, limitations }
}
