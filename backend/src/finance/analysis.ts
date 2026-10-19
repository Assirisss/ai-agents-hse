import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FinanceAnalysis, FinanceAnalysisFact, FinanceAnalysisRequest, FinanceEvidence, FinanceSnapshot, Operation, OperationFilter } from '../../../shared/finance.js'
import { dateSchema, FinanceError, moscowToday } from './schema.js'
import { formatMoney as money, sumKopecks } from './money.js'

const day = 86_400_000
export function shiftDate(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * day).toISOString().slice(0, 10) }
const daysIn = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / day) + 1
export const analysisRequestSchema = z.object({
  kind: z.enum(['changes', 'breakdown', 'unusual', 'recurring', 'scenario', 'weekly']),
  from: dateSchema.optional(), to: dateSchema.optional(), previousFrom: dateSchema.optional(), previousTo: dateSchema.optional(),
  accountId: z.string().min(1).max(100).optional(), categoryId: z.string().min(1).max(100).optional(),
  query: z.string().trim().min(3).max(200).optional(),
  reductionPercent: z.number().min(0).max(100).refine(value => Number(value.toFixed(2)) === value, 'Не больше двух знаков после запятой').optional(),
}).strict().superRefine((value, context) => {
  for (const [from, to] of [[value.from, value.to], [value.previousFrom, value.previousTo]]) {
    if (Boolean(from) !== Boolean(to) || from && to && (from > to || daysIn(from, to) > 366)) context.addIssue({ code: 'custom', message: 'Нужен период от 1 до 366 дней с обеими датами' })
  }
  if (value.previousFrom && value.kind !== 'changes') context.addIssue({ code: 'custom', message: 'Второй период доступен для сравнения расходов' })
  if (value.previousFrom && !value.from) context.addIssue({ code: 'custom', message: 'Укажите оба сравниваемых периода' })
  if (value.from && value.to && value.previousFrom && value.previousTo && (daysIn(value.from, value.to) !== daysIn(value.previousFrom, value.previousTo) || value.previousTo >= value.from)) context.addIssue({ code: 'custom', message: 'Периоды должны быть одинаковой длины и не пересекаться' })
  if (value.kind === 'scenario' && (value.reductionPercent === undefined || !value.categoryId && !value.query)) context.addIssue({ code: 'custom', message: 'Для сценария нужны явно заданные процент и категория либо описание расходов' })
})

/** Defaults compare the same elapsed days of adjacent months, including leap/short months. */
export function analysisPeriods(request: FinanceAnalysisRequest, today: string) {
  const notes: string[] = []
  let from = request.from, to = request.to
  let previousFrom = request.previousFrom, previousTo = request.previousTo
  if (!from || !to) {
    to = today
    from = request.kind === 'weekly' ? shiftDate(today, -6) : request.kind === 'recurring' ? shiftDate(today, -179) : `${today.slice(0, 7)}-01`
    if (request.kind === 'changes') {
      const lastPrevious = shiftDate(from, -1)
      const count = Math.min(Number(today.slice(8)), Number(lastPrevious.slice(8)))
      to = shiftDate(from, count - 1)
      previousFrom = `${lastPrevious.slice(0, 7)}-01`
      previousTo = shiftDate(previousFrom, count - 1)
      if (to !== today) notes.push(`Для равной длительности сравниваются первые ${count} дней каждого месяца; дни ${shiftDate(to, 1)} — ${today} в это сравнение не включены.`)
    }
  }
  if (to > today || previousTo && previousTo > today) throw new FinanceError('Анализ доступен по сегодняшний день; будущие операции не учитываются')
  if (!previousFrom || !previousTo) { previousTo = shiftDate(from, -1); previousFrom = shiftDate(from, -daysIn(from, to)) }
  return { period: { from, to }, previousPeriod: { from: previousFrom, to: previousTo }, notes }
}

function selected(operations: Operation[], filter: OperationFilter) {
  return operations.filter(item => item.status === 'posted' && (!filter.from || item.date >= filter.from) && (!filter.to || item.date <= filter.to) && (!filter.kind || item.kind === filter.kind) && (!filter.accountId || item.accountId === filter.accountId || item.kind === 'transfer' && item.destinationAccountId === filter.accountId) && (!filter.categoryId || item.categoryId === filter.categoryId) && (!filter.query || item.description.toLocaleLowerCase('ru-RU').includes(filter.query.toLocaleLowerCase('ru-RU'))))
}
function evidence(operations: Operation[], filter: OperationFilter, label: string): FinanceEvidence {
  const rows = selected(operations, filter)
  return { label, filter: { ...filter }, count: rows.length, operationIds: rows.map(item => item.id) }
}
const total = (rows: Operation[]) => sumKopecks(rows.map(item => item.amount))
const normalized = (text: string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
function groups(rows: Operation[], key: (item: Operation) => string) {
  const result = new Map<string, Operation[]>()
  for (const row of rows) { const id = key(row); const items = result.get(id) || []; items.push(row); result.set(id, items) }
  return result
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : Number((BigInt(sorted[middle - 1]!) + BigInt(sorted[middle]!) + 1n) / 2n)
}

/** Pure analytics: all money arithmetic is integer kopecks and only posted records are read. */
export function analyzeFinance(snapshot: FinanceSnapshot, raw: FinanceAnalysisRequest, now = new Date()): FinanceAnalysis {
  const request = analysisRequestSchema.parse(raw), today = moscowToday(now)
  if (request.accountId && !snapshot.accounts.some(item => item.id === request.accountId)) throw new FinanceError('Счёт не найден в этом профиле', 404)
  if (request.categoryId && !snapshot.categories.some(item => item.id === request.categoryId && item.kind === 'expense')) throw new FinanceError('Категория расходов не найдена в этом профиле', 404)
  const { period, previousPeriod, notes } = analysisPeriods(request, today)
  const scope: OperationFilter = { ...(request.accountId ? { accountId: request.accountId } : {}), ...(request.categoryId ? { categoryId: request.categoryId } : {}), ...(request.query ? { query: request.query } : {}) }
  const currentFilter = { ...scope, ...period, kind: 'expense' as const }, previousFilter = { ...scope, ...previousPeriod, kind: 'expense' as const }
  const current = selected(snapshot.operations, currentFilter), previous = selected(snapshot.operations, previousFilter)
  const titles = { changes: 'За счёт чего изменились расходы', breakdown: 'Детализация расходов', unusual: 'Необычные расходы и возможные дубликаты', recurring: 'Возможные регулярные платежи', scenario: 'Сценарий изменения расходов', weekly: 'Финансовая сводка' }
  const result: FinanceAnalysis = { id: randomUUID(), kind: request.kind, title: titles[request.kind], period, facts: [], limitations: ['Выводы основаны только на внесённых подтверждённых операциях. Отсутствие записей не доказывает отсутствие расходов.', ...notes] }
  let index = 0
  const add = (text: string, links: FinanceEvidence[] = [], type: FinanceAnalysisFact['type'] = 'fact', factScope?: OperationFilter) => {
    result.facts.push({ id: `${result.id}:${++index}`, type, text, evidence: links, ...(factScope ? { scope: factScope } : {}) })
  }
  const currentLink = evidence(snapshot.operations, currentFilter, `Расходы ${period.from} — ${period.to}`)
  const previousLink = evidence(snapshot.operations, previousFilter, `Расходы ${previousPeriod.from} — ${previousPeriod.to}`)
  const categoryName = (id: string) => snapshot.categories.find(item => item.id === id)?.name || 'Без категории'
  const label = request.categoryId ? ` Категория: «${categoryName(request.categoryId)}».` : request.query ? ` Описание содержит «${request.query}».` : ''
  if (request.accountId) result.limitations.push(`Выбран счёт «${snapshot.accounts.find(item => item.id === request.accountId)!.name}».`)

  if (request.kind === 'changes' || request.kind === 'weekly') {
    result.previousPeriod = previousPeriod
    const expense = total(current), earlier = total(previous), delta = sumKopecks([expense, -earlier])
    add(`За ${period.from} — ${period.to} учтено расходов ${money(expense)} (${current.length} операций); за ${previousPeriod.from} — ${previousPeriod.to} — ${money(earlier)} (${previous.length} операций). Изменение: ${delta > 0 ? '+' : ''}${money(delta)}.${label}`, [currentLink, previousLink], 'fact', currentFilter)
    if (!current.length || !previous.length) result.limitations.push('В одном из сравниваемых периодов нет расходных записей. Надёжный вывод о росте или снижении фактических расходов сделать нельзя.')
    const currentGroups = groups(current, item => item.categoryId || ''), previousGroups = groups(previous, item => item.categoryId || '')
    const drivers = [...new Set([...currentGroups.keys(), ...previousGroups.keys()])].map(id => ({ id, amount: total(currentGroups.get(id) || []), earlier: total(previousGroups.get(id) || []) })).map(item => ({ ...item, delta: sumKopecks([item.amount, -item.earlier]) })).filter(item => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    for (const item of drivers.slice(0, 5)) {
      const filter = { ...scope, categoryId: item.id || undefined, kind: 'expense' as const }
      add(`Категория «${categoryName(item.id)}»: ${money(item.earlier)} → ${money(item.amount)}; вклад в изменение учтённых расходов ${item.delta > 0 ? '+' : ''}${money(item.delta)}.`, [evidence(snapshot.operations, { ...filter, ...period }, `«${categoryName(item.id)}»: текущий период`), evidence(snapshot.operations, { ...filter, ...previousPeriod }, `«${categoryName(item.id)}»: предыдущий период`)], 'fact', { ...filter, ...period })
    }
    if (drivers.length > 5) result.limitations.push(`Показаны 5 категорий с наибольшим абсолютным изменением из ${drivers.length}. Уменьшения также влияют на общий итог.`)
    const largest = [...current].sort((a, b) => b.amount - a.amount)[0]
    if (largest) {
      const sameDescription = previous.filter(item => normalized(item.description) === normalized(largest.description))
      if (largest.description.trim() && !sameDescription.length && previous.length) {
        const filter = { ...currentFilter, query: largest.description }
        add(`Возможная разовая покупка: «${largest.description}», ${money(largest.amount)}, ${largest.date}. Такое же описание не встречалось в предыдущем периоде. Разовый характер нужно подтвердить: по записи нельзя установить причину покупки.`, [evidence(snapshot.operations, filter, 'Проверить покупку')], 'hypothesis', filter)
      }
    }
    if (request.kind === 'weekly') {
      const allFilter = { ...scope, ...period }, rows = selected(snapshot.operations, allFilter)
      const incomeRows = rows.filter(item => item.kind === 'income'), income = total(incomeRows)
      add(`Доходы за период: ${money(income)}; расходы: ${money(expense)}; разница: ${money(sumKopecks([income, -expense]))}. Переводы исключены.`, [evidence(snapshot.operations, { ...allFilter, kind: 'income' }, 'Доходы за период'), currentLink])
      const until = shiftDate(today, 6)
      const payments = snapshot.payments.filter(item => item.status === 'active' && item.dueDate >= today && item.dueDate <= until && (!request.accountId || item.accountId === request.accountId) && (!request.categoryId || item.categoryId === request.categoryId)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.time.localeCompare(b.time))
      add(payments.length ? `Ближайшие сохранённые напоминания (${today} — ${until}): ${payments.slice(0, 5).map(item => `«${item.title}» — ${item.dueDate} ${item.time} МСК${item.amount === null ? ', сумма не задана' : `, ${money(item.amount)}`}`).join('; ')}. Это плановые платежи, они не включены в расходы.` : `На ${today} — ${until} активных сохранённых напоминаний о платежах не найдено.`)
      result.limitations.push('Сроки платежей взяты из сохранённых напоминаний; выполнение задачи и фактическая оплата учитываются отдельно.')
    }
  } else if (request.kind === 'breakdown') {
    add(`За ${period.from} — ${period.to} учтено ${money(total(current))} расходов по ${current.length} операциям.${label}`, [currentLink], 'fact', currentFilter)
    const descriptions = [...groups(current, item => normalized(item.description) || '(без описания)').values()].sort((a, b) => total(b) - total(a))
    for (const rows of descriptions.slice(0, 5)) {
      const item = rows[0]!
      const filter = { ...currentFilter, ...(item.description.trim() ? { query: item.description } : {}) }
      // IDs include the exact group; the UI explicitly labels the filtered ledger as a current view.
      add(`Описание «${item.description || 'Без описания'}»: ${money(total(rows))}, ${rows.length} операций.`, [{ label: 'Операции с этим описанием', filter, operationIds: rows.map(row => row.id), count: rows.length }], 'fact', filter)
    }
    for (const item of [...current].sort((a, b) => b.amount - a.amount).slice(0, 3)) {
      add(`Крупная запись: ${item.date}, «${item.description || 'Без описания'}», ${money(item.amount)}.`, [{ label: 'Проверить запись', filter: { ...currentFilter, from: item.date, to: item.date, query: item.description || undefined }, operationIds: [item.id], count: 1 }])
    }
    result.limitations.push('Одинаковые описания сгруппированы по тексту; это не подтверждает одного продавца. Показаны 5 крупнейших групп и 3 крупнейшие записи.')
  } else if (request.kind === 'unusual') {
    add(`Проверено ${current.length} расходных записей за ${period.from} — ${period.to}.${label}`, [currentLink])
    const baselineFilter = { ...scope, from: shiftDate(period.from, -90), to: shiftDate(period.from, -1), kind: 'expense' as const }
    const baseline = selected(snapshot.operations, baselineFilter)
    const baselineGroups = groups(baseline, item => item.categoryId || '')
    let found = 0
    for (const item of [...current].sort((a, b) => b.amount - a.amount)) {
      const history = baselineGroups.get(item.categoryId || '') || []
      if (history.length < 5 || new Set(history.map(row => row.date)).size < 3) continue
      const typical = median(history.map(row => row.amount)), deviation = median(history.map(row => Math.abs(row.amount - typical)))
      const threshold = Math.max(typical * 2, typical + deviation * 3)
      if (item.amount <= threshold || found >= 5) continue
      found++
      add(`Необычно крупная запись: «${item.description || 'Без описания'}», ${item.date}, ${money(item.amount)}. Медиана выбранных записей категории «${categoryName(item.categoryId || '')}» за 90 дней до периода — ${money(typical)} (${history.length} записей). Сумма больше удвоенной медианы и медианы плюс три медианных отклонения. Это повод проверить запись, а не вывод о мошенничестве.`, [{ label: 'Проверить необычную запись', filter: { ...currentFilter, from: item.date, to: item.date }, operationIds: [item.id], count: 1 }, evidence(snapshot.operations, { ...baselineFilter, categoryId: item.categoryId || undefined }, 'История для сравнения')], 'hypothesis')
    }
    const duplicates = [...groups(current.filter(item => item.description.trim()), item => JSON.stringify([item.date, item.amount, item.accountId, normalized(item.description)])).values()].filter(rows => rows.length > 1)
    for (const rows of duplicates.slice(0, 3)) add(`Возможный дубликат: ${rows.length} записей по ${money(rows[0]!.amount)}, ${rows[0]!.date}, описание «${rows[0]!.description}», один счёт. Это могут быть разные покупки; сверьте их вручную.`, [{ label: 'Проверить совпавшие записи', filter: { ...currentFilter, from: rows[0]!.date, to: rows[0]!.date, query: rows[0]!.description }, operationIds: rows.map(item => item.id), count: rows.length }], 'hypothesis')
    if (!found && !duplicates.length) add('По выбранным правилам необычных сумм и возможных дубликатов не найдено. Это не гарантирует отсутствие ошибок или подозрительных списаний.')
    if (!baselineGroups.size || [...baselineGroups.values()].some(rows => rows.length < 5 || new Set(rows.map(row => row.date)).size < 3) || current.some(item => !baselineGroups.has(item.categoryId || ''))) result.limitations.push('Для части категорий недостаточно истории: нужно минимум 5 предыдущих записей на 3 разных датах. Для них отклонения суммы не оценивались.')
    result.limitations.push('Порог — максимум из удвоенной медианы и медианы плюс три медианных абсолютных отклонения; медианы округлены до копейки. Это эвристика, не оценка безопасности банка.')
  } else if (request.kind === 'recurring') {
    add(`Проверено ${current.length} расходных записей за ${period.from} — ${period.to}.${label}`, [currentLink])
    let found = 0
    for (const rows of groups(current.filter(item => item.description.trim()), item => JSON.stringify([item.accountId, item.categoryId, normalized(item.description)])).values()) {
      const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date)), dates = [...new Set(sorted.map(item => item.date))]
      if (dates.length < 3) continue
      const gaps = dates.slice(1).map((date, index) => daysIn(dates[index]!, date) - 1)
      const weekly = gaps.every(gap => gap >= 6 && gap <= 8), monthly = gaps.every(gap => gap >= 26 && gap <= 33)
      const typical = median(rows.map(item => item.amount))
      if ((!weekly && !monthly) || rows.some(item => BigInt(Math.abs(item.amount - typical)) * 10n > BigInt(typical))) continue
      found++
      if (found > 6) continue
      add(`Возможный ${weekly ? 'еженедельный' : 'ежемесячный'} платёж «${sorted[0]!.description}»: ${rows.length} записей, медианная сумма ${money(typical)}, последняя дата ${dates.at(-1)}. Интервалы ${Math.min(...gaps)}–${Math.max(...gaps)} дней, суммы отличаются от медианы не больше чем на 10%. Подтвердите, что это подписка или постоянный платёж.`, [{ label: 'Проверить повторения', filter: { ...currentFilter, accountId: sorted[0]!.accountId, categoryId: sorted[0]!.categoryId || undefined, query: sorted[0]!.description }, operationIds: rows.map(item => item.id), count: rows.length }], 'hypothesis')
    }
    if (!found) add('Подходящих повторений не найдено. Для кандидата нужны минимум 3 даты, одинаковые счёт/категория/нормализованное описание, интервалы 6–8 либо 26–33 дня и суммы в пределах 10% от медианы.')
    result.limitations.push('Кандидаты не подтверждают подписку и не создают напоминания автоматически. Различающиеся описания не объединяются; пропущенные записи могут скрыть повторение.')
  } else if (request.kind === 'scenario') {
    const amount = total(current), basisPoints = Math.round(request.reductionPercent! * 100)
    const saving = Number((BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n)
    add(`За ${period.from} — ${period.to} выбранные расходы составили ${money(amount)} по ${current.length} операциям.${label}`, [currentLink], 'fact', currentFilter)
    add(`Если уменьшить именно этот объём расходов на ${request.reductionPercent}%, разница составит ${money(saving)}, а оставшаяся сумма — ${money(sumKopecks([amount, -saving]))}. Это расчёт по выбранному прошлому периоду, а не прогноз будущих трат.`, [currentLink])
    if (!current.length) result.question = 'По выбранной категории или описанию записей нет. Уточните категорию, описание или период.'
    result.limitations.push('Сценарий предполагает пропорциональное сокращение выбранных расходов; он не оценивает необходимость покупок и возможность реально их сократить. Округление — до копейки.')
  }
  for (const [index, fact] of result.facts.entries()) {
    if (index === 0 || (request.kind === 'changes' || request.kind === 'weekly') && index < 3 || request.kind === 'unusual' || request.kind === 'recurring' || request.kind === 'scenario' || request.kind === 'weekly' && (fact.text.startsWith('Доходы за период') || !fact.evidence.length)) fact.required = true
    for (const link of fact.evidence) link.filter.operationIds = link.operationIds
  }
  return result
}

export function renderAnalysis(analysis: FinanceAnalysis) {
  const facts = analysis.facts.filter(item => item.type === 'fact'), hypotheses = analysis.facts.filter(item => item.type === 'hypothesis')
  return [analysis.title, ...facts.map(item => item.text), ...(hypotheses.length ? ['Предположения для проверки:', ...hypotheses.map(item => item.text)] : []), 'Ограничения данных:', ...analysis.limitations, ...(analysis.question ? [analysis.question] : [])].join('\n\n')
}
export function analysisEvidence(analysis: FinanceAnalysis) {
  const seen = new Set<string>()
  return analysis.facts.flatMap(item => item.evidence).filter(item => { const key = JSON.stringify([item.filter, item.operationIds]); if (seen.has(key)) return false; seen.add(key); return true })
}
