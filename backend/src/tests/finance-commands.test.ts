import assert from 'node:assert/strict'
import test from 'node:test'
import type { Account, Category, Draft, DraftInput, Operation, OperationFilter } from '../../../shared/finance.js'
import { runFinanceCommands } from '../finance/commands.js'
import type { AgentFinancePort } from '../finance/tools.js'

const now = new Date('2026-10-18T18:00:00Z')
function fixture() {
  const accounts: Account[] = [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 0, balance: 30_000, archived: false }, { id: 'card', name: 'Карта', currency: 'RUB', initialBalance: 0, balance: 90_000, archived: false }]
  const categories: Category[] = [{ id: 'food', name: 'Продукты', kind: 'expense' }, { id: 'salary', name: 'Зарплата', kind: 'income' }]
  const drafts: Draft[] = [], operations: Operation[] = []
  function missing(input: DraftInput) { return ['kind', 'amount', 'date', 'accountId', ...(input.kind === 'transfer' ? ['destinationAccountId'] : ['categoryId'])].filter(field => !input[field as keyof DraftInput]) }
  const port: AgentFinancePort & { drafts(): Promise<Draft[]> } = {
    accounts: async () => accounts, categories: async () => categories, drafts: async () => drafts,
    operations: async (filter: OperationFilter) => operations.filter(item => item.status === 'posted' && (!filter.from || item.date >= filter.from) && (!filter.to || item.date <= filter.to) && (!filter.kind || item.kind === filter.kind) && (!filter.accountId || item.accountId === filter.accountId || item.destinationAccountId === filter.accountId) && (!filter.categoryId || item.categoryId === filter.categoryId)),
    stats: async () => { throw new Error('Test must use exact operation data') },
    createDraft: async input => { const draft: Draft = { ...input, id: `draft-${drafts.length + 1}`, source: 'text', status: 'pending', createdAt: now.toISOString(), missing: missing(input), warnings: [] }; drafts.push(draft); return draft },
    updateDraft: async (id, input) => { const draft = drafts.find(item => item.id === id)!; Object.assign(draft, input); draft.missing = missing(draft); return draft },
  }
  return { port, drafts, operations, run: (text: string, context: { activeDraft?: Draft; filter?: OperationFilter; now?: Date } = {}) => runFinanceCommands(port, text, { now, ...context }) }
}

test('entry commands create only a grounded draft, with an explicit default-date note', async () => {
  const s = fixture()
  const result = await s.run('/expense 850,50 продукты; счёт Наличные')
  assert.equal(result?.method, 'rules')
  assert.equal(result?.draft?.amount, 85_050)
  assert.equal(result?.draft?.date, '2026-10-18')
  assert.equal(result?.draft?.accountId, 'cash')
  assert.equal(result?.draft?.categoryId, 'food')
  assert.deepEqual(result?.draft?.missing, [])
  assert.equal(result?.draft?.provenance?.amount?.excerpt, '850,50')
  assert.match(result?.draft?.provenance?.date?.note || '', /дата не указана/)
  assert.match(result?.text || '', /после вашего подтверждения/)
  assert.equal(s.operations.length, 0)
  const income = await s.run('/income 10000 зарплата; счёт Карта; дата вчера')
  assert.equal(income?.draft?.kind, 'income')
  assert.equal(income?.draft?.categoryId, 'salary')
  assert.equal(income?.draft?.date, '2026-10-17')
})

test('free text leaves absent date/account missing and short followups update the same draft', async () => {
  const s = fixture()
  const first = await s.run('Потратил 850 на продукты')
  assert.deepEqual(first?.draft?.missing, ['date', 'accountId'])
  assert.equal(first?.draft?.date, undefined)
  const account = await s.run('с карты', { activeDraft: first!.draft })
  assert.equal(account?.draft?.accountId, 'card')
  assert.equal(account?.draft?.provenance?.accountId?.excerpt, 'карты')
  const date = await s.run('вчера', { activeDraft: account!.draft })
  assert.equal(date?.draft?.date, '2026-10-17')
  assert.deepEqual(date?.draft?.missing, [])
  await s.run('сумма 850,05', { activeDraft: date!.draft })
  assert.equal(s.drafts[0]?.amount, 85_005)
  assert.equal(s.drafts.length, 1)
})

test('singular natural income and expense entries are not treated as statistical queries', async () => {
  const s = fixture()
  assert.equal((await s.run('доход 500 зарплата'))?.draft?.kind, 'income')
  assert.equal((await s.run('расход 850 продукты'))?.draft?.kind, 'expense')
  assert.equal(s.drafts.length, 2)
})

test('a combined date and account clarification updates the active draft while a command creates another', async () => {
  const s = fixture()
  const first = await s.run('Потратил 850 рублей на продукты')
  const refined = await s.run('Сегодня, со счёта Наличные', { activeDraft: first!.draft })
  assert.equal(refined?.draft?.id, first?.draft?.id)
  assert.equal(refined?.draft?.date, '2026-10-18')
  assert.equal(refined?.draft?.accountId, 'cash')
  assert.deepEqual(refined?.draft?.missing, [])
  const next = await s.run('/expense 100 продукты', { activeDraft: refined!.draft })
  assert.notEqual(next?.draft?.id, first?.draft?.id)
  assert.equal(s.drafts.length, 2)
})

test('an explicit field correction cannot silently change other draft fields', async () => {
  const s = fixture()
  const first = await s.run('/expense 850 продукты; счёт Карта')
  const result = await s.run('описание Купил 200 товаров вчера за 50 рублей', { activeDraft: first!.draft })
  assert.equal(result?.draft?.description, 'Купил 200 товаров вчера за 50 рублей')
  assert.equal(result?.draft?.amount, 85_000)
  assert.equal(result?.draft?.date, '2026-10-18')
  assert.equal(result?.draft?.accountId, 'card')
})

test('transfer command identifies both named accounts and does not require a category', async () => {
  const result = await fixture().run('/transfer 500; со счёта Карта; на счёт Наличные')
  assert.equal(result?.draft?.kind, 'transfer')
  assert.equal(result?.draft?.accountId, 'card')
  assert.equal(result?.draft?.destinationAccountId, 'cash')
  assert.deepEqual(result?.draft?.missing, [])
})

test('decimal parsing is exact at high values, including grouped rubles and kopecks', async () => {
  const s = fixture()
  assert.equal((await s.run('/expense 999999999999,99 продукты'))?.draft?.amount, 99_999_999_999_999)
  assert.equal((await s.run('/expense 12 345,67 продукты'))?.draft?.amount, 1_234_567)
  assert.equal((await s.run('/expense 15 копеек продукты'))?.draft?.amount, 15)
  assert.equal((await s.run('/expense 1,25 тыс. продукты'))?.draft?.amount, 125_000)
})

test('multiple sums, invalid precision and impossible/conflicting dates cause clarification without writes', async () => {
  const s = fixture()
  for (const text of ['/expense 500 и 200 продукты', '/expense 500 и 500 продукты', '/expense -500 продукты', '/expense 10,333 продукты', '/expense 500 продукты; дата 31.02.2026', '/expense 500 продукты вчера сегодня', '/expense 1000000000001 продукты']) {
    const result = await s.run(text)
    assert.ok(result && !result.draft, text)
  }
  assert.equal(s.drafts.length, 0)
})

test('dates use Moscow midnight and past operations keep the explicitly given past date', async () => {
  const s = fixture()
  const result = await s.run('вчера потратил 100 рублей с карты на продукты', { now: new Date('2026-10-18T21:30:00Z') })
  assert.equal(result?.draft?.date, '2026-10-18')
  assert.equal((await s.run('/expense 100 продукты дата 01.01.2026'))?.draft?.date, '2026-01-01')
})

test('statistics have exact evidence and followup filters preserve the current context', async () => {
  const s = fixture()
  const base: Operation = { id: 'oct-card', kind: 'expense', amount: 850_05, accountId: 'card', categoryId: 'food', date: '2026-10-10', description: 'Продукты', status: 'posted', createdAt: now.toISOString(), updatedAt: now.toISOString() }
  s.operations.push(base, { ...base, id: 'oct-cash', amount: 100_00, accountId: 'cash' }, { ...base, id: 'september', date: '2026-09-10', amount: 200_00 }, { ...base, id: 'future', date: '2026-10-19' }, { ...base, id: 'cancelled', status: 'cancelled' }, { ...base, id: 'transfer', kind: 'transfer', destinationAccountId: 'cash' })
  const current = await s.run('/expenses')
  assert.match(current?.text || '', /950,05/)
  assert.deepEqual(current?.evidence?.[0]?.operationIds, ['oct-card', 'oct-cash'])
  const card = await s.run('только по карте', { filter: current?.filter })
  assert.equal(card?.filter?.accountId, 'card')
  assert.deepEqual(card?.evidence?.[0]?.operationIds, ['oct-card'])
  const previous = await s.run('а за прошлый месяц?', { filter: card?.filter })
  assert.deepEqual(previous?.filter, { from: '2026-09-01', to: '2026-09-30', kind: 'expense', accountId: 'card' })
  assert.deepEqual(previous?.evidence?.[0]?.operationIds, ['september'])
  assert.match(previous?.text || '', /200,00/)
})

test('accounts, categories, balances and drafts are available without model calls', async () => {
  const s = fixture()
  assert.match((await s.run('/accounts'))?.text || '', /Наличные/)
  assert.match((await s.run('/categories'))?.text || '', /Зарплата/)
  assert.match((await s.run('покажи остаток по карте'))?.text || '', /900,00/)
  assert.match((await s.run('/drafts'))?.text || '', /нет/)
  assert.equal(await s.run('Составь нестандартный анализ финансовой устойчивости'), null)
  assert.ok(!(await s.run('/confirm'))?.draft)
})

test('combined income and expense requests clear an earlier kind filter and include both kinds', async () => {
  const s = fixture()
  const base: Operation = { id: 'expense', kind: 'expense', amount: 20_000, accountId: 'card', categoryId: 'food', date: '2026-10-10', description: 'Еда', status: 'posted', createdAt: now.toISOString(), updatedAt: now.toISOString() }
  s.operations.push(base, { ...base, id: 'income', kind: 'income', categoryId: 'salary', amount: 100_000 }, { ...base, id: 'transfer', kind: 'transfer', destinationAccountId: 'cash' })
  for (const text of ['Покажи доходы и расходы за этот месяц', 'Покажи расходы и доходы за этот месяц', '/period доходы и расходы']) {
    const result = await s.run(text, { filter: { kind: 'expense', accountId: 'card' } })
    assert.equal(result?.filter?.kind, undefined)
    assert.equal(result?.filter?.accountId, 'card')
    assert.match(result?.text || '', /Доходы: 1\s000,00/)
    assert.match(result?.text || '', /расходы: 200,00/)
    assert.match(result?.text || '', /разница: 800,00/)
    assert.deepEqual(result?.evidence?.[0]?.operationIds, ['expense', 'income', 'transfer'])
  }
})
