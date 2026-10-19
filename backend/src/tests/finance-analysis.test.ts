import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { FinanceAnalysis, FinanceSnapshot, Operation, Payment } from '../../../shared/finance.js'
import { analyzeFinance, analysisPeriods, analysisRequestSchema, renderAnalysis } from '../finance/analysis.js'
import { analysisIntent, resolveAnalysisRequest } from '../finance/analysis-intent.js'
import { emptyFinance, MemoryFinanceStore } from '../finance/store.js'
import { FinanceService } from '../finance/service.js'
import { financePort } from '../finance/ports.js'
import { FinanceChatService } from '../finance/chat.js'
import { runFinanceCommands } from '../finance/commands.js'
import { runFinanceAgent } from '../finance/agent.js'
import { createFinanceTools } from '../finance/tools.js'
import { createAnalysisTools } from '../finance/analysis-tools.js'
import type { ResearchPlanner } from '../trends/planner.js'
import { createApp } from '../app.js'

const now = new Date('2026-10-19T09:00:00Z')
function entry(id: string, date: string, amount: number, extra: Partial<Operation> = {}): Operation {
  return { id, date, amount, kind: 'expense', accountId: 'cash', categoryId: 'food', description: 'Продукты', status: 'posted', createdAt: now.toISOString(), updatedAt: now.toISOString(), ...extra }
}
function snapshot(): FinanceSnapshot {
  const data = emptyFinance()
  data.accounts.push({ id: 'card', name: 'Карта', currency: 'RUB', balance: 0, initialBalance: 0, archived: false })
  return data
}
function seedChanges() {
  const data = snapshot()
  data.operations.push(entry('old-food', '2026-09-10', 100_000), entry('old-home', '2026-09-15', 50_000, { categoryId: 'home', description: 'Дом' }), entry('food', '2026-10-10', 200_000), entry('transport', '2026-10-15', 70_000, { categoryId: 'transport', description: 'Проездной' }), entry('income', '2026-10-15', 500_000, { kind: 'income', categoryId: 'salary' }), entry('transfer', '2026-10-15', 999_000, { kind: 'transfer', destinationAccountId: 'card', categoryId: null }), entry('future', '2026-10-20', 999_000), entry('cancelled', '2026-10-10', 999_000, { status: 'cancelled' }))
  return data
}

test('comparison uses equal elapsed days, exact positive/negative category contributions and both periods as sources', () => {
  const data = seedChanges(), before = structuredClone(data), report = analyzeFinance(data, { kind: 'changes' }, now)
  assert.deepEqual(report.period, { from: '2026-10-01', to: '2026-10-19' })
  assert.deepEqual(report.previousPeriod, { from: '2026-09-01', to: '2026-09-19' })
  assert.match(report.facts[0]!.text, /2\s700,00/)
  assert.match(report.facts[0]!.text, /1\s500,00/)
  assert.match(report.facts[0]!.text, /\+1\s200,00/)
  assert.ok(report.facts.some(fact => fact.text.includes('Дом') && fact.text.includes('−500,00')))
  assert.ok(report.facts.some(fact => fact.text.includes('Транспорт') && fact.text.includes('+700,00')))
  assert.deepEqual(new Set(report.facts[0]!.evidence.flatMap(item => item.operationIds)), new Set(['old-food', 'old-home', 'food', 'transport']))
  for (const fact of report.facts) for (const link of fact.evidence) assert.deepEqual(link.filter.operationIds, link.operationIds)
  assert.deepEqual(data, before)
})

test('short/leap months remain comparable; sparse history never proves real-world growth', () => {
  const short = analysisPeriods({ kind: 'changes' }, '2026-03-31')
  assert.deepEqual(short.period, { from: '2026-03-01', to: '2026-03-28' })
  assert.deepEqual(short.previousPeriod, { from: '2026-02-01', to: '2026-02-28' })
  assert.ok(short.notes[0]!.includes('28'))
  assert.equal(analysisPeriods({ kind: 'changes' }, '2028-03-31').period.to, '2028-03-29')
  const data = snapshot(); data.operations.push(entry('only', '2026-10-10', 10000))
  const report = analyzeFinance(data, { kind: 'changes' }, now)
  assert.ok(report.limitations.some(item => item.includes('Надёжный вывод')))
  assert.doesNotMatch(renderAnalysis(report), /100%|100 %/)
})

test('anomaly checks use only prior history and enough samples, and duplicate candidates stay hypotheses', () => {
  const data = snapshot()
  for (let i = 0; i < 5; i++) data.operations.push(entry(`history-${i}`, `2026-09-${String(10 + i).padStart(2, '0')}`, 10000))
  data.operations.push(entry('large', '2026-10-10', 100000, { description: 'Крупная покупка' }), entry('duplicate-1', '2026-10-11', 15000, { description: 'Магазин' }), entry('duplicate-2', '2026-10-11', 15000, { description: 'Магазин' }), entry('no-history', '2026-10-12', 999999, { categoryId: 'transport' }))
  const report = analyzeFinance(data, { kind: 'unusual' }, now)
  const large = report.facts.find(item => item.text.includes('Необычно крупная'))!
  assert.equal(large.type, 'hypothesis')
  assert.deepEqual(large.evidence[0]!.operationIds, ['large'])
  assert.deepEqual(large.evidence[1]!.operationIds, ['history-0', 'history-1', 'history-2', 'history-3', 'history-4'])
  assert.ok(report.facts.some(item => item.type === 'hypothesis' && item.text.includes('Возможный дубликат')))
  assert.ok(report.limitations.some(item => item.includes('недостаточно истории')))
})

test('recurrence needs three distinct dates, consistent intervals, similar sums and the same description/account', () => {
  const data = snapshot()
  for (const [index, date] of ['2026-08-15', '2026-09-15', '2026-10-15'].entries()) data.operations.push(entry(`monthly-${index}`, date, 10000, { description: 'Подписка' }))
  for (const [index, date] of ['2026-10-01', '2026-10-08', '2026-10-15'].entries()) data.operations.push(entry(`weekly-${index}`, date, 20000, { description: 'Доставка воды' }))
  for (let i = 0; i < 3; i++) data.operations.push(entry(`same-day-${i}`, '2026-10-10', 10000, { description: 'Один день' }))
  const report = analyzeFinance(data, { kind: 'recurring' }, now)
  assert.equal(report.facts.filter(item => item.type === 'hypothesis').length, 2)
  assert.ok(report.facts.some(item => item.text.includes('ежемесячный')))
  assert.ok(report.facts.some(item => item.text.includes('еженедельный')))
  assert.ok(!report.facts.some(item => item.type === 'hypothesis' && item.text.includes('Один день')))
})

test('scenario computes integer savings at large amounts and explicitly stays a scenario', () => {
  const data = snapshot()
  for (let i = 0; i < 40; i++) data.operations.push(entry(`big-${i}`, '2026-10-10', 99_999_999_999_999))
  const before = structuredClone(data)
  const report = analyzeFinance(data, { kind: 'scenario', categoryId: 'food', reductionPercent: 20.25 }, now)
  const saving = (99_999_999_999_999n * 40n * 2025n + 5000n) / 10000n
  assert.match(report.facts[1]!.text, /20.25%/)
  assert.ok(report.facts[1]!.text.includes((saving / 100n).toLocaleString('ru-RU')))
  assert.match(report.facts[1]!.text, /не прогноз/)
  assert.deepEqual(data, before)
  assert.throws(() => analyzeFinance(data, { kind: 'scenario', reductionPercent: 20 }, now))
  assert.throws(() => analyzeFinance(data, { kind: 'scenario', categoryId: 'food', reductionPercent: -1 }, now))
})

test('weekly summary separates income, expenses, transfers and upcoming saved obligations', () => {
  const data = seedChanges()
  const payment: Payment = { id: 'p', planningTaskId: 'task', title: 'Аренда', dueDate: '2026-10-20', time: '09:00', amount: 100000, status: 'active', syncStatus: 'synced', rrule: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }
  data.payments.push(payment, { ...payment, id: 'cancelled', title: 'Отменённый', status: 'cancelled' })
  const report = analyzeFinance(data, { kind: 'weekly' }, now)
  assert.deepEqual(report.period, { from: '2026-10-13', to: '2026-10-19' })
  assert.ok(report.facts.some(item => item.text.includes('Доходы за период: 5') && item.text.includes('700,00')))
  assert.ok(report.facts.some(item => item.text.includes('Аренда') && item.text.includes('не включены в расходы')))
  assert.doesNotMatch(renderAnalysis(report), /Отменённый/)
})

test('routing reaches every analysis workflow without a model while entry commands keep rules', async () => {
  const finance = new FinanceService(new MemoryFinanceStore(), undefined, undefined, { now: () => now }), port = financePort(finance, 'review')
  for (const text of ['Почему в этом месяце потратил больше?', 'Есть ли необычные расходы?', 'Найди мои регулярные платежи', 'Что будет, если сократить продукты на 20%?', 'Как прошла моя финансовая неделя?']) {
    assert.ok(analysisIntent(text), text)
    assert.equal(await runFinanceCommands(port, text, { now }), null)
    const result = await runFinanceAgent(port, text, { now })
    assert.ok(result.analysis, text)
    assert.equal(result.method, 'rules')
  }
  assert.equal(analysisIntent('/expense 850 продукты'), undefined)
  assert.ok((await runFinanceCommands(port, '/expense 850 продукты', { now }))?.draft)
})

test('scope resolution clarifies missing parameters and explicit new requests reset old filters', () => {
  const data = snapshot(), prior = { accountId: 'card', categoryId: 'transport' }
  const standalone = resolveAnalysisRequest('Почему в этом месяце потратил больше?', 'changes', data.accounts, data.categories, now, prior)
  assert.equal(standalone.request?.accountId, undefined)
  assert.equal(standalone.request?.categoryId, undefined)
  assert.ok(resolveAnalysisRequest('Сократить продукты на сколько-то процентов', 'scenario', data.accounts, data.categories, now).question)
  assert.ok(resolveAnalysisRequest('Что будет, если сократить расходы на 20%?', 'scenario', data.accounts, data.categories, now).question)
  assert.equal(resolveAnalysisRequest('Что будет, если сократить доставку на 20%?', 'scenario', data.accounts, data.categories, now).request?.query, 'доставк')
  assert.equal(resolveAnalysisRequest('Что будет, если сократить продукты на 20.25%?', 'scenario', data.accounts, data.categories, now).request?.reductionPercent, 20.25)
  assert.ok(resolveAnalysisRequest('Что будет, если сократить продукты на -20%?', 'scenario', data.accounts, data.categories, now).question)
  const explicit = resolveAnalysisRequest('Сравни расходы 2026-09-01 2026-09-19 и 2026-10-01 2026-10-19', 'changes', data.accounts, data.categories, now)
  assert.equal(explicit.request?.previousFrom, '2026-09-01')
  assert.equal(explicit.request?.from, '2026-10-01')
  assert.ok(!analysisRequestSchema.safeParse({ kind: 'changes', from: '2026-10-01', to: '2026-10-19', previousFrom: '2026-09-01', previousTo: '2026-09-20' }).success)
})

test('agent drills into drivers and composes existing facts, never invented prose or fact IDs', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store, undefined, undefined, { now: () => now })
  await store.transact('review', data => Object.assign(data, seedChanges()))
  const original = await store.read('review'), port = financePort(finance, 'review')
  let turn = 0
  const planner: ResearchPlanner = { async next(messages, tools) {
    assert.ok(tools.every(tool => !/create|update|confirm|cancel/.test(tool.name)))
    const reports = messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).filter((item): item is FinanceAnalysis => Array.isArray(item.facts))
    if (turn++ === 0) return { content: 'Из-за командировок вы потратили 999999 рублей.', calls: [{ name: 'finance_expense_breakdown', arguments: { categoryId: 'transport', from: '2020-01-01', to: '2020-01-01' } }] }
    const latest = reports.at(-1)!
    if (turn === 2) return { content: '', calls: [{ name: 'finance_explain_analysis', arguments: { factIds: ['invented-fact'], hypothesisIds: [] } }] }
    return { content: 'Покупайте акции.', calls: [{ name: 'finance_explain_analysis', arguments: { factIds: latest.facts.filter(item => item.type === 'fact').slice(0, 2).map(item => item.id), hypothesisIds: [] } }] }
  } }
  const result = await runFinanceAgent(port, 'Почему в этом месяце потратил больше?', { now, planner })
  assert.equal(result.method, 'mixed')
  assert.ok(result.steps.some(step => step.tool === 'finance_explain_analysis' && step.status === 'error'))
  assert.ok(result.steps.some(step => step.tool === 'finance_expense_breakdown' && step.status === 'ok'))
  assert.doesNotMatch(result.text, /999999|командиров|Покупайте/)
  assert.match(result.text, /Проездной/)
  assert.equal(result.analysis?.period.from, '2026-10-01')
  assert.ok(result.evidence!.flatMap(item => item.operationIds).includes('old-food'))
  assert.deepEqual(await store.read('review'), original)
})

test('tools reject cross-profile arguments, and model failure preserves computed results', async () => {
  const finance = new FinanceService(new MemoryFinanceStore(), undefined, undefined, { now: () => now }), port = financePort(finance, 'review')
  const tools = createFinanceTools(port)
  await assert.rejects(tools.find(item => item.name === 'finance_compare_expenses')!.execute({ profileId: 'another' }))
  await assert.rejects(tools.find(item => item.name === 'finance_compare_expenses')!.execute({ accountId: 'another' }))
  assert.ok(!createAnalysisTools(port, { kind: 'changes' }).some(item => item.name === 'finance_spending_scenario'))
  const result = await runFinanceAgent(port, 'Почему выросли расходы?', { now, planner: { async next() { throw new Error('provider-secret') } } })
  assert.ok(result.analysis)
  assert.equal(result.method, 'rules')
  assert.match(result.text, /Модель не завершила/)
  assert.doesNotMatch(result.text, /provider-secret/)
})

test('analysis chat persists its sources and replays without creating drafts or money records', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store, undefined, undefined, { now: () => now })
  await store.transact('review', data => Object.assign(data, seedChanges()))
  const chat = new FinanceChatService(finance, undefined, () => now), conversation = await chat.create('review')
  const request = { turnId: randomUUID(), expectedRevision: 0, text: 'Почему выросли расходы?' }
  const first = await chat.send('review', conversation.id, request)
  assert.ok(first.conversation.messages.at(-1)!.reply!.analysis)
  const repeated = await new FinanceChatService(finance, undefined, () => now).send('review', conversation.id, request)
  assert.equal(repeated.replayed, true)
  assert.equal(first.messageId, repeated.messageId)
  const data = await store.read('review')
  assert.equal(data.drafts.length, 0)
  assert.equal(data.audit.length, 0)
  assert.equal(data.operations.length, seedChanges().operations.length)
})

test('HTTP analysis works independently, validates requests and isolates profile evidence', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store, undefined, undefined, { now: () => now })
  await store.transact('owner', data => Object.assign(data, seedChanges()))
  const app = createApp(undefined, { finance })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/finance/analysis?profileId=owner', payload: { kind: 'changes' } })
    assert.equal(response.statusCode, 200)
    assert.ok(response.json<FinanceAnalysis>().facts[0]!.evidence[0]!.operationIds.includes('food'))
    const other = await app.inject({ method: 'POST', url: '/api/finance/analysis?profileId=other', payload: { kind: 'changes' } })
    assert.equal(other.statusCode, 200)
    assert.deepEqual(other.json<FinanceAnalysis>().facts[0]!.evidence.flatMap(item => item.operationIds), [])
    assert.equal((await app.inject({ method: 'POST', url: '/api/finance/analysis?profileId=owner', payload: { kind: 'changes', profileId: 'other' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/finance/analysis?profileId=owner', payload: { kind: 'changes', from: '2026-02-30', to: '2026-03-01' } })).statusCode, 400)
  } finally { await app.close() }
})

test('a hypothesis cannot be promoted to a fact and analysis never offers mutation tools', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store, undefined, undefined, { now: () => now })
  const data = seedChanges(); data.operations.push(entry('one-off', '2026-10-16', 900_000, { description: 'Новый прибор' }))
  await store.transact('review', target => Object.assign(target, data))
  let turn = 0
  const result = await runFinanceAgent(financePort(finance, 'review'), 'Почему выросли расходы?', { now, planner: { async next(messages) {
    const report = JSON.parse(messages.find(item => item.role === 'tool' && item.tool_name === 'finance_compare_expenses')!.content) as FinanceAnalysis
    if (turn++ === 0) return { content: '', calls: [{ name: 'finance_explain_analysis', arguments: { factIds: [report.facts.find(item => item.type === 'hypothesis')!.id] } }] }
    return { content: '', calls: [{ name: 'finance_explain_analysis', arguments: { factIds: [report.facts[0]!.id], hypothesisIds: [report.facts.find(item => item.type === 'hypothesis')!.id] } }] }
  } } })
  assert.ok(result.steps.some(item => item.status === 'error'))
  assert.equal(result.analysis!.facts.find(item => item.text.includes('Новый прибор'))!.type, 'hypothesis')
  assert.equal((await store.read('review')).drafts.length, 0)
})
