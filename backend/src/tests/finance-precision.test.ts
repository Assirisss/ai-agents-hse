import assert from 'node:assert/strict'
import test from 'node:test'
import type { Operation } from '../../../shared/finance.js'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore } from '../finance/store.js'
import { decimalRubles, formatMoney, sumKopecks } from '../finance/money.js'
import { runFinanceAgent } from '../finance/agent.js'
import { financePort } from '../finance/setup.js'
import { FinanceTelegramBot, TelegramClient, type FinanceTelegramPort } from '../finance/telegram.js'

const date = '2026-10-18'
const createdAt = `${date}T10:00:00Z`
const largeAmount = 100_000_000_000_000
function operation(id: string, kind: 'income' | 'expense', amount: number): Operation {
  return { id, kind, amount, date, accountId: 'cash', categoryId: kind === 'income' ? 'salary' : 'food', description: '', status: 'posted', createdAt, updatedAt: createdAt }
}

void test('balances retain every kopeck when unordered rows cross the safe intermediate Number range', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  const incomes = Array.from({ length: 100 }, (_, index) => operation(`income-${index}`, 'income', largeAmount))
  const expenses = Array.from({ length: 100 }, (_, index) => operation(`expense-${index}`, 'expense', largeAmount - 1))
  const orderings = [
    [...incomes, ...expenses],
    [...expenses, ...incomes],
    incomes.flatMap((income, index) => [income, expenses[index]!]),
  ]
  for (const operations of orderings) {
    await store.transact('alice', (data) => { data.operations = operations })
    assert.equal((await finance.state('alice')).accounts[0]!.balance, 100)
  }
})

void test('cancellation that would overflow a balance rolls back both status and audit', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  await store.transact('alice', (data) => {
    data.operations = [...Array.from({ length: 91 }, (_, index) => operation(`income-${index}`, 'income', largeAmount)), operation('expense-to-cancel', 'expense', largeAmount)]
  })
  assert.equal((await finance.state('alice')).accounts[0]!.balance, 9_000_000_000_000_000)
  await assert.rejects(finance.cancelOperation('alice', 'expense-to-cancel'), /Остаток.*точность/)
  const state = await finance.state('alice')
  assert.equal(state.operations.find((item) => item.id === 'expense-to-cancel')!.status, 'posted')
  assert.equal(state.accounts[0]!.balance, 9_000_000_000_000_000)
  assert.deepEqual(await finance.history('alice', 'expense-to-cancel'), [])
})

void test('unrepresentable statistics reject exact totals even when the net balance is small', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  await store.transact('alice', (data) => {
    data.operations = Array.from({ length: 100 }, (_, index) => [operation(`income-${index}`, 'income', largeAmount), operation(`expense-${index}`, 'expense', largeAmount - 1)]).flat()
  })
  assert.equal((await finance.state('alice')).accounts[0]!.balance, 100)
  await assert.rejects(finance.stats('alice', date, date), /Сумма статистики.*точность/)
})

void test('statistics report a one-kopeck net exactly near the supported numeric boundary', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  await store.transact('alice', (data) => {
    data.operations = [...Array.from({ length: 90 }, (_, index) => operation(`income-${index}`, 'income', largeAmount)), ...Array.from({ length: 90 }, (_, index) => operation(`expense-${index}`, 'expense', largeAmount - (index === 0 ? 1 : 0)))]
  })
  const stats = await finance.stats('alice', date, date)
  assert.equal(stats.income, 9_000_000_000_000_000)
  assert.equal(stats.expense, 8_999_999_999_999_999)
  assert.equal(stats.net, 1)
  assert.equal(stats.expenseByCategory[0]!.amount, stats.expense)
})

void test('decimal and localized RUB formatting keep supported kopecks exactly', () => {
  const amount = 8_999_999_999_999_999
  assert.equal(decimalRubles(amount), '89999999999999.99')
  assert.equal(formatMoney(amount).replace(/\s/gu, ''), '89999999999999,99₽')
  assert.equal(decimalRubles(-amount), '-89999999999999.99')
  assert.equal(formatMoney(-1), '−0,01 ₽')
  assert.equal(sumKopecks([amount, 1, -amount]), 1)
  assert.throws(() => sumKopecks([Number.MAX_SAFE_INTEGER, 1]), /точность/)
  assert.throws(() => formatMoney(Number.MAX_SAFE_INTEGER + 1), /точность/)
})

void test('agent and module context render exact kopecks from deterministic service totals', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store, undefined, undefined, { now: () => new Date(createdAt) })
  await store.transact('alice', (data) => {
    data.operations = Array.from({ length: 90 }, (_, index) => operation(`income-${index}`, 'income', largeAmount - (index === 0 ? 1 : 0)))
  })
  const context = await finance.moduleContext('alice')
  assert.match(context.facts[0]!, /89999999999999\.99 RUB/)
  let requested = false
  const reply = await runFinanceAgent(financePort(finance, 'alice'), 'Покажи баланс', { planner: { async next() {
    if (requested) return { content: '', calls: [] }
    requested = true
    return { content: '', calls: [{ name: 'finance_accounts', arguments: {} }] }
  } } })
  assert.match(reply.text.replace(/\s/gu, ''), /89999999999999,99₽/)
})

void test('Telegram balance and monthly expenses format exact kopecks and reject overflow totals', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  await store.transact('alice', (data) => {
    data.operations = Array.from({ length: 90 }, (_, index) => operation(`expense-${index}`, 'expense', largeAmount - (index === 0 ? 1 : 0)))
  })
  const sent: string[] = []
  const port: FinanceTelegramPort = {
    claimUpdate: async () => true, bindingForUser: async () => ({ profileId: 'alice' }), consumeLinkCode: async () => false,
    state: (profileId) => finance.state(profileId),
    createTextDraft: async () => { throw new Error('unused') }, createReceiptDraft: async () => { throw new Error('unused') },
    updateDraft: async () => { throw new Error('unused') }, confirmDraft: async () => { throw new Error('unused') }, cancelDraft: async () => {},
    setPendingDraft: async () => {}, pendingDraft: async () => null, summary: async () => { throw new Error('unused') }, getCursor: async () => 0, setCursor: async () => {},
  }
  const client = new TelegramClient('123:test-token', { fetch: async (_url, init) => { sent.push(JSON.parse(String(init?.body)).text); return Response.json({ ok: true, result: true }) } })
  const bot = new FinanceTelegramBot(port, client, { now: () => new Date(createdAt) })
  const message = (updateId: number, text: string) => ({ update_id: updateId, message: { from: { id: 7 }, chat: { id: 7, type: 'private' }, text } })
  await bot.handleUpdate(message(1, '/balance'))
  assert.match(sent[0]!.replace(/\s/gu, ''), /−89999999999999,99₽/)
  await bot.handleUpdate(message(2, '/expenses'))
  assert.match(sent[1]!.replace(/\s/gu, ''), /89999999999999,99₽/)
  await store.transact('alice', (data) => {
    data.operations.push(operation('overflow-expense', 'expense', largeAmount))
    data.operations.push(operation('balancing-income', 'income', largeAmount))
  })
  await bot.handleUpdate(message(3, '/expenses'))
  assert.match(sent[2]!, /Не удалось выполнить действие/)
  assert.doesNotMatch(sent[2]!, /₽/)
})
