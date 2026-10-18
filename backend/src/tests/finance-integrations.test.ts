import assert from 'node:assert/strict'
import test from 'node:test'
import type { Delivery, Draft, DraftInput, FinanceState, MarketSummary, Operation } from '../../../shared/finance.js'
import { MarketService } from '../finance/market.js'
import { FinanceTelegramBot, TelegramApiError, TelegramClient, type FinanceTelegramPort, type TelegramUpdate } from '../finance/telegram.js'
import { FinanceWorker, type FinanceWorkerPort } from '../finance/worker.js'

const NOW = new Date('2026-10-16T18:00:00.000Z')
const instrument = { ticker: 'SBER', name: 'Сбербанк' }
const summary: MarketSummary = { id: 'summary', date: '2026-10-16', generatedAt: NOW.toISOString(), quotes: [], text: 'MOEX test summary' }
function table(columns: string[], data: unknown[][]) { return { columns, data } }
function json(body: unknown) { return Response.json(body) }

test('MOEX search excludes other instruments; quote uses official previous close', async () => {
  const calls: string[] = []
  const fetcher = (async (url: URL | string | Request) => {
    calls.push(String(url))
    if (!String(url).includes('/SBER.json')) return json({ securities: table(['SECID', 'SHORTNAME', 'SECTYPE', 'CURRENCYID'], [['SBER', 'Сбербанк', '1', 'SUR'], ['SBERP', 'Сбер преф', '2', 'RUB'], ['FUND', 'Fund', 'J', 'SUR'], ['USD', 'USD stock', '1', 'USD']]) })
    return json({ securities: table(['SECID', 'SECTYPE', 'CURRENCYID', 'PREVLEGALCLOSEPRICE'], [['SBER', '1', 'SUR', 250]]), marketdata: table(['SECID', 'LAST', 'TRADEDATE', 'SYSTIME', 'TIME'], [['SBER', 255, '2026-10-16', '2026-10-16 20:45:00', '20:44:00']]) })
  }) as typeof fetch
  const market = new MarketService({ fetch: fetcher, now: () => NOW })
  assert.deepEqual((await market.search('')).map(item => item.ticker), ['SBER', 'SBERP'])
  assert.equal((await market.instrument('SBER')).ticker, 'SBER')
  const result = await market.summary([instrument])
  assert.equal(result.quotes[0]?.price, '255')
  assert.equal(result.quotes[0]?.previousClose, '250')
  assert.equal(result.quotes[0]?.change, '5')
  assert.equal(result.quotes[0]?.changePercent, '2')
  assert.equal(result.quotes[0]?.tradedAt, '2026-10-16T20:44:00+03:00')
  assert.equal(result.quotes[0]?.stale, false)
  assert.match(result.text, /задержкой/)
  assert.equal(calls.filter(url => !url.includes('/SBER.json')).length, 1, 'catalogue is cached')
  await assert.rejects(market.instrument('../secret'), /тикер/)
})

test('MOEX history fallback uses two actual trading dates and marks weekend prices stale', async () => {
  const market = new MarketService({ now: () => new Date('2026-10-18T18:00:00Z'), fetch: (async (url: URL | string | Request) => String(url).includes('/history/') ? json({ history: table(['TRADEDATE', 'LEGALCLOSEPRICE', 'CLOSE'], [['2026-10-15', 250, 251], ['2026-10-16', 255, 256]]) }) : json({ securities: table(['SECID', 'SECTYPE', 'CURRENCYID', 'PREVLEGALCLOSEPRICE'], [['SBER', '1', 'SUR', 255]]), marketdata: table(['SECID', 'LAST'], [['SBER', null]]) })) as typeof fetch })
  const result = await market.summary([instrument])
  assert.equal(result.quotes[0]?.price, '255')
  assert.equal(result.quotes[0]?.previousClose, '250')
  assert.equal(result.quotes[0]?.tradedAt, '2026-10-16')
  assert.equal(result.quotes[0]?.stale, true)
  assert.match(result.text, /последняя доступная дата/)
})

test('MOEX preserves sub-kopeck price precision and does not divide by zero', async () => {
  let previous = 0.005
  const market = new MarketService({ now: () => NOW, fetch: (async () => json({ securities: table(['SECID', 'SECTYPE', 'CURRENCYID', 'PREVLEGALCLOSEPRICE'], [['SBER', '1', 'SUR', previous]]), marketdata: table(['SECID', 'LAST', 'TRADEDATE', 'TIME'], [['SBER', 0.00505, '2026-10-16', '20:45:00']]) })) as typeof fetch })
  const quote = await market.quote(instrument)
  assert.equal(quote.price, '0.00505')
  assert.equal(quote.change, '0.00005')
  assert.equal(quote.changePercent, '1')
  previous = 0
  assert.equal((await market.quote(instrument)).changePercent, null)
})

test('MOEX outage retains cached quote with original date, and never fabricates data', async () => {
  const market = new MarketService({ now: () => NOW, fetch: (async () => { throw new Error('secret upstream') }) as typeof fetch })
  const cached = { ticker: 'SBER', name: 'Сбербанк', price: '255', previousClose: '250', change: '5', changePercent: '2', currency: 'RUB' as const, tradedAt: '2026-10-15', fetchedAt: '2026-10-15T19:00:00Z', sourceUrl: '', stale: false }
  const result = await market.summary([instrument], [cached])
  assert.equal(result.quotes[0]?.price, '255')
  assert.equal(result.quotes[0]?.tradedAt, '2026-10-15')
  assert.equal(result.quotes[0]?.fetchedAt, cached.fetchedAt)
  assert.equal(result.quotes[0]?.stale, true)
  assert.match(result.text, /Свежие данные MOEX недоступны/)
  assert.equal((await market.summary([instrument])).quotes[0]?.price, null)
})

test('MOEX never treats system timestamp as trade date; uses dated trade records or history', async () => {
  const market = new MarketService({ now: () => NOW, fetch: (async (url: URL | string | Request) => {
    if (String(url).includes('/trades.json')) return json({ trades: table(['SECID', 'BOARDID', 'PRICE', 'TRADETIME', 'SYSTIME'], [['SBER', 'TQBR', 257, '20:40:00', '2026-10-16 20:40:01']]) })
    return json({ securities: table(['SECID', 'SECTYPE', 'CURRENCYID', 'PREVLEGALCLOSEPRICE'], [['SBER', '1', 'SUR', 250]]), marketdata: table(['SECID', 'LAST', 'SYSTIME', 'TIME'], [['SBER', 256, '2026-10-16 20:45:00', '20:45:00']]) })
  }) as typeof fetch })
  const quote = await market.quote(instrument)
  assert.equal(quote.price, '257')
  assert.equal(quote.tradedAt, '2026-10-16T20:40:00+03:00')
  assert.equal(quote.change, '7')
  const stale = new MarketService({ now: () => new Date('2026-10-18T18:00:00Z'), fetch: (async (url: URL | string | Request) => {
    if (String(url).includes('/trades.json')) return json({ trades: table([], []) })
    if (String(url).includes('/history/')) return json({ history: table(['TRADEDATE', 'LEGALCLOSEPRICE'], [['2026-10-15', 250], ['2026-10-16', 255]]) })
    return json({ securities: table(['SECID', 'SECTYPE', 'CURRENCYID', 'PREVLEGALCLOSEPRICE'], [['SBER', '1', 'SUR', 255]]), marketdata: table(['SECID', 'LAST', 'SYSTIME', 'TIME'], [['SBER', 256, '2026-10-18 20:45:00', '20:45:00']]) })
  }) as typeof fetch })
  const previous = await stale.quote(instrument)
  assert.equal(previous.tradedAt, '2026-10-16')
  assert.equal(previous.price, '255')
  assert.equal(previous.previousClose, '250')
  assert.equal(previous.stale, true)
})

function botFixture() {
  const state: FinanceState = { accounts: [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 100_000, balance: 100_000, archived: false }], categories: [{ id: 'food', name: 'Продукты', kind: 'expense' }], operations: [], drafts: [], watchlist: [], summaries: [], telegram: null, deliveries: [], capabilities: { text: true, vision: true, telegram: true } }
  let linked = false; let pending: string | null = null; let cursor = 0
  const claimed = new Set<number>(); const sent: { method: string; body: Record<string, unknown> }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/file/bot')) return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } })
    const method = url.split('/').at(-1)!
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return json({ ok: true, result: method === 'getFile' ? { file_path: 'photos/receipt.jpg', file_size: 4 } : true })
  }) as typeof fetch
  const makeDraft = (source: Draft['source']): Draft => { const draft: Draft = { id: 'draft-1', source, kind: 'expense', amount: 15_000, date: '2026-10-16', accountId: 'cash', description: 'Чек', missing: ['categoryId'], warnings: [], status: 'pending', createdAt: NOW.toISOString() }; state.drafts.push(draft); return draft }
  const port: FinanceTelegramPort = {
    async claimUpdate(id) { if (claimed.has(id)) return false; claimed.add(id); return true },
    async bindingForUser(user, chat) { return linked && user === '7' && chat === '7' ? { profileId: 'owner' } : null },
    async consumeLinkCode(code, user, chat) { if (code !== 'valid-code' || linked || user !== '7' || chat !== '7') return false; linked = true; return true },
    async state(profile) { assert.equal(profile, 'owner'); return state },
    async createTextDraft(profile) { assert.equal(profile, 'owner'); return makeDraft('text') },
    async createReceiptDraft(profile, file) { assert.equal(profile, 'owner'); assert.equal(file.bytes.byteLength, 4); return makeDraft('receipt') },
    async updateDraft(_profile, id, patch: DraftInput) { const draft = state.drafts.find(item => item.id === id)!; Object.assign(draft, patch); draft.missing = draft.categoryId ? [] : ['categoryId']; return draft },
    async confirmDraft(_profile, id) { const draft = state.drafts.find(item => item.id === id)!; assert.equal(draft.missing.length, 0); const operation: Operation = { id: 'op', kind: 'expense', amount: draft.amount!, date: draft.date!, accountId: draft.accountId!, categoryId: draft.categoryId, description: '', status: 'posted', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }; state.operations.push(operation); state.accounts[0]!.balance -= operation.amount; draft.status = 'confirmed'; return operation },
    async cancelDraft(_profile, id) { state.drafts.find(item => item.id === id)!.status = 'cancelled' },
    async setPendingDraft(_profile, id) { pending = id }, async pendingDraft() { return pending }, async summary() { return summary }, async getCursor() { return cursor }, async setCursor(value) { cursor = value },
  }
  const bot = new FinanceTelegramBot(port, new TelegramClient('12345:mock-token', { fetch: fetcher }), { now: () => NOW })
  const message = (id: number, text?: string): TelegramUpdate => ({ update_id: id, message: { message_id: id, from: { id: 7 }, chat: { id: 7, type: 'private' }, ...(text ? { text } : {}) } })
  const callback = (id: number, data: string, user = 7): TelegramUpdate => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: user }, message: { message_id: 1, chat: { id: user, type: 'private' } }, data } })
  return { bot, port, state, sent, message, callback }
}

test('Telegram photo → correction → explicit confirmation; duplicate update/callback has no extra write', async () => {
  const fixture = botFixture()
  await fixture.bot.handleUpdate(fixture.message(1, '/start valid-code'))
  const photo = fixture.message(2); photo.message!.photo = [{ file_id: 'photo', file_size: 4 }]
  await fixture.bot.handleUpdate(photo)
  assert.equal(fixture.state.drafts.length, 1)
  assert.equal(fixture.state.operations.length, 0)
  const initial = fixture.sent.find(item => item.method === 'sendMessage' && String(item.body.text).startsWith('Черновик'))!
  assert.ok(!JSON.stringify(initial.body.reply_markup).includes('confirm:'), 'incomplete draft cannot be confirmed from its keyboard')
  await fixture.bot.handleUpdate(fixture.callback(3, 'edit:draft-1'))
  await fixture.bot.handleUpdate(fixture.message(4, 'категория Продукты'))
  assert.equal(fixture.state.operations.length, 0)
  await fixture.bot.handleUpdate(fixture.callback(5, 'confirm:draft-1:0'))
  await fixture.bot.handleUpdate(fixture.callback(5, 'confirm:draft-1:0'))
  await fixture.bot.handleUpdate(fixture.callback(6, 'confirm:draft-1:0'))
  assert.equal(fixture.state.operations.length, 1)
  assert.equal(fixture.state.accounts[0]?.balance, 85_000)
})

test('Telegram ignores groups and rejects callbacks from another user', async () => {
  const fixture = botFixture()
  await fixture.bot.handleUpdate(fixture.message(1, '/start valid-code'))
  await fixture.bot.handleUpdate(fixture.message(2, 'купил продукты'))
  await fixture.bot.handleUpdate(fixture.callback(3, 'confirm:draft-1:0', 8))
  const group = fixture.message(4, 'сумма 50'); group.message!.chat.type = 'group'
  await fixture.bot.handleUpdate(group)
  assert.equal(fixture.state.operations.length, 0)
  assert.equal(fixture.state.drafts[0]?.amount, 15_000)
})

test('Telegram API network failures expose no token and report ambiguous delivery', async () => {
  const token = '12345:private-secret'
  const client = new TelegramClient(token, { fetch: (async () => { throw new Error(`network ${token}`) }) as typeof fetch })
  await assert.rejects(client.sendText('7', 'hello'), error => error instanceof TelegramApiError && error.ambiguous && !error.message.includes(token))
})

test('Telegram monthly expenses exclude future, cancelled, transfer and other-month records', async () => {
  const fixture = botFixture()
  await fixture.bot.handleUpdate(fixture.message(1, '/start valid-code'))
  const base: Operation = { id: 'posted', kind: 'expense', amount: 10000, date: '2026-10-16', accountId: 'cash', description: '', status: 'posted', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }
  fixture.state.operations = [base, { ...base, id: 'future', date: '2026-10-17' }, { ...base, id: 'past-month', date: '2026-09-30' }, { ...base, id: 'cancelled', status: 'cancelled' }, { ...base, id: 'transfer', kind: 'transfer' }]
  await fixture.bot.handleUpdate(fixture.message(2, '/expenses'))
  const text = String(fixture.sent.at(-1)?.body.text)
  assert.match(text, /100,00/)
  assert.ok(!text.includes('500,00'))
})

function workerFixture() {
  let delivery: Delivery | null = null
  const port: FinanceWorkerPort = {
    async profiles() { return [{ profileId: 'owner', chatId: '7', watchlist: [instrument] }] },
    async claimDelivery(_profile, date, now) {
      if (delivery && (delivery.status !== 'failed' || delivery.attempts >= 3 || Date.parse(now) - Date.parse(delivery.updatedAt) < 60_000)) return null
      delivery = { id: 'delivery', date, status: 'sending', attempts: (delivery?.attempts ?? 0) + 1, updatedAt: now }; return delivery
    },
    async summary() { return summary },
    async finishDelivery(_profile, _id, status, error) { delivery = { ...delivery!, status, error } },
  }
  return { port, delivery: () => delivery }
}

test('worker catches up only today at 21 Moscow and durable claim prevents duplicates after restart', async () => {
  const fixture = workerFixture(); const sent: string[] = []
  let now = new Date('2026-10-16T17:59:00Z')
  const send = async (_chat: string, text: string) => { sent.push(text) }
  const worker = new FinanceWorker(fixture.port, send, { now: () => now })
  await worker.tick(); assert.equal(sent.length, 0)
  now = NOW; await worker.tick(); assert.equal(sent.length, 1)
  assert.equal(fixture.delivery()?.date, '2026-10-16')
  assert.equal(fixture.delivery()?.status, 'sent')
  await new FinanceWorker(fixture.port, send, { now: () => now }).tick()
  assert.equal(sent.length, 1)
})

test('worker limits definitive failures to three attempts; ambiguous timeouts never auto-retry', async () => {
  const definite = workerFixture(); let attempts = 0; let now = NOW
  const worker = new FinanceWorker(definite.port, async () => { attempts++; throw new TelegramApiError('Rejected', false, true) }, { now: () => now })
  for (let index = 0; index < 5; index++) { await worker.tick(); now = new Date(now.getTime() + 61_000) }
  assert.equal(attempts, 3)
  const ambiguous = workerFixture(); let ambiguousAttempts = 0
  const uncertain = new FinanceWorker(ambiguous.port, async () => { ambiguousAttempts++; throw new TelegramApiError('Timeout', true, true) }, { now: () => now })
  await uncertain.tick(); now = new Date(now.getTime() + 61_000); await uncertain.tick()
  assert.equal(ambiguous.delivery()?.status, 'uncertain')
  assert.equal(ambiguousAttempts, 1)
})
