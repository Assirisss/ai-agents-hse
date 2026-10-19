import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../app.js'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore } from '../finance/store.js'
import { FinanceTelegramBot, TelegramClient, type FinanceTelegramPort } from '../finance/telegram.js'

const input = { kind: 'expense' as const, amount: 85_000, date: '2026-10-19', accountId: 'cash', categoryId: 'food', description: 'Обед' }

test('HTTP operation edits reject an old window without changing money, category or audit', async () => {
  const finance = new FinanceService(new MemoryFinanceStore())
  const draft = await finance.createDraft('review', input)
  const operation = await finance.confirmDraft('review', draft.id)
  assert.equal(operation.revision, 0)
  const app = createApp(undefined, { finance })
  const url = `/api/finance/operations/${operation.id}?profileId=review`
  const save = (payload: object) => app.inject({ method: 'PATCH', url, payload })
  try {
    for (const invalid of [{ ...input }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 0.5 }]) {
      assert.equal((await save(invalid)).statusCode, 400)
    }
    const first = await save({ ...input, amount: 850_000, expectedRevision: 0 })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().revision, 1)
    const auditBeforeConflict = await finance.history('review', operation.id)
    const stale = await save({ ...input, categoryId: 'other-expense', expectedRevision: 0 })
    assert.equal(stale.statusCode, 409)
    assert.match(stale.json().error, /Обновите данные/)
    const current = await finance.state('review')
    assert.equal(current.operations[0]!.amount, 850_000)
    assert.equal(current.operations[0]!.categoryId, 'food')
    assert.equal(current.operations[0]!.revision, 1)
    assert.equal(current.accounts[0]!.balance, -850_000)
    assert.deepEqual(await finance.history('review', operation.id), auditBeforeConflict)
    const refreshed = await save({ ...input, amount: 850_000, categoryId: 'other-expense', expectedRevision: 1 })
    assert.equal(refreshed.statusCode, 200)
    assert.equal(refreshed.json().revision, 2)
    assert.equal((await finance.state('review')).accounts[0]!.balance, -850_000)
    const audit = await finance.history('review', operation.id)
    assert.equal(audit.length, 3)
    assert.ok(audit.some(item => item.action === 'operation.updated' && (item.after as { revision?: number }).revision === 2))
  } finally { await app.close() }
})

test('legacy operation version zero permits only one of two competing edits; cancellation still blocks edits', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  const draft = await finance.createDraft('review', input)
  const operation = await finance.confirmDraft('review', draft.id)
  await store.transact('review', data => { delete data.operations[0]!.revision })
  const saves = await Promise.allSettled([
    finance.updateOperation('review', operation.id, { ...input, amount: 100_000 }, 0),
    finance.updateOperation('review', operation.id, { ...input, amount: 200_000 }, 0),
  ])
  const successful = saves.filter(item => item.status === 'fulfilled')
  assert.equal(successful.length, 1)
  const rejected = saves.find(item => item.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.statusCode, 409)
  const current = (await finance.state('review')).operations[0]!
  assert.equal(current.revision, 1)
  assert.equal((await finance.state('review')).accounts[0]!.balance, -current.amount)
  assert.equal((await finance.history('review', operation.id)).length, 2)
  await finance.cancelOperation('review', operation.id)
  await assert.rejects(() => finance.updateOperation('review', operation.id, input, 1), { statusCode: 409 })
  assert.equal((await finance.state('review')).accounts[0]!.balance, 0)
})

test('HTTP draft writes require the displayed revision; stale saves and confirmations cannot change money', async () => {
  const finance = new FinanceService(new MemoryFinanceStore())
  const draft = await finance.createDraft('review', input)
  const app = createApp(undefined, { finance })
  const url = `/api/finance/drafts/${draft.id}`
  const request = (method: 'PATCH' | 'POST', suffix: string, payload?: object) => app.inject({ method, url: `${url}${suffix}?profileId=review`, payload })
  try {
    assert.equal((await request('PATCH', '', { amount: 1 })).statusCode, 400)
    assert.equal((await request('POST', '/confirm')).statusCode, 400)
    assert.equal((await request('POST', '/confirm', { expectedRevision: -1 })).statusCode, 400)
    const saved = await request('PATCH', '', { amount: 850_000, expectedRevision: 0 })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().revision, 1)
    assert.equal((await request('PATCH', '', { amount: 85_000, expectedRevision: 0 })).statusCode, 409)
    assert.equal((await request('POST', '/confirm', { expectedRevision: 0 })).statusCode, 409)
    const pending = await finance.state('review')
    assert.equal(pending.drafts[0]!.amount, 850_000)
    assert.equal(pending.accounts[0]!.balance, 0)
    assert.equal(pending.operations.length, 0)
    const confirmed = await request('POST', '/confirm', { expectedRevision: 1 })
    assert.equal(confirmed.statusCode, 200)
    const replay = await request('POST', '/confirm', { expectedRevision: 1 })
    assert.equal(replay.statusCode, 200)
    assert.equal(replay.json().id, confirmed.json().id)
    assert.equal((await finance.state('review')).accounts[0]!.balance, -850_000)
  } finally { await app.close() }
})

test('two concurrent saves cannot both overwrite the same draft version; legacy drafts start at zero', async () => {
  const store = new MemoryFinanceStore(), finance = new FinanceService(store)
  const draft = await finance.createDraft('review', input)
  await store.transact('review', data => { delete data.drafts[0]!.revision })
  const results = await Promise.allSettled([
    finance.updateDraft('review', draft.id, { amount: 10_000 }, 0),
    finance.updateDraft('review', draft.id, { amount: 20_000 }, 0),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.statusCode, 409)
  assert.equal((await finance.state('review')).drafts[0]!.revision, 1)
  assert.equal((await finance.state('review')).operations.length, 0)
})

for (const scenario of ['stale', 'legacy', 'race'] as const) {
  test(`Telegram ${scenario} confirmation shows a new preview; only its version can be posted`, async () => {
    const store = new MemoryFinanceStore(), finance = new FinanceService(store)
    const draft = await finance.createDraft('review', input)
    const sent: { text?: string; reply_markup?: { inline_keyboard: { callback_data: string }[][] } }[] = []
    let race = scenario === 'race'
    const port: FinanceTelegramPort = {
      claimUpdate: id => store.claimUpdate(id), bindingForUser: async () => ({ profileId: 'review' }),
      consumeLinkCode: async () => false, state: id => finance.state(id),
      createTextDraft: async () => { throw new Error('unused') }, createReceiptDraft: async () => { throw new Error('unused') },
      updateDraft: (profile, id, patch) => finance.updateDraft(profile, id, patch),
      confirmDraft: async (profile, id, revision) => {
        // Change after the callback reads the preview but before the transaction takes the lock.
        if (race) { race = false; await finance.updateDraft(profile, id, { amount: 850_000 }) }
        return finance.confirmDraft(profile, id, revision)
      },
      cancelDraft: async (profile, id) => { await finance.cancelDraft(profile, id) },
      setPendingDraft: (profile, id) => finance.setPendingDraft(profile, id), pendingDraft: profile => finance.pendingDraft(profile),
      summary: async () => { throw new Error('unused') }, getCursor: () => store.cursor(), setCursor: async next => { await store.cursor(next) },
    }
    const client = new TelegramClient('123:test', { fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, result: true })
    } })
    const bot = new FinanceTelegramBot(port, client)
    if (scenario !== 'race') await finance.updateDraft('review', draft.id, { amount: 850_000 })
    const callback = (updateId: number, data: string) => bot.handleUpdate({ update_id: updateId, callback_query: {
      id: `callback-${updateId}`, from: { id: 42 }, data, message: { message_id: 1, chat: { id: 42, type: 'private' } },
    } })
    await callback(1, `confirm:${draft.id}${scenario === 'legacy' ? '' : ':0'}`)
    assert.equal((await finance.state('review')).operations.length, 0)
    assert.ok(sent.some(item => item.text?.includes('подтвердите заново')))
    const preview = sent.findLast(item => item.reply_markup)!
    assert.ok(preview.text?.includes('8 500,00') || preview.text?.includes('8\u00a0500,00'))
    const button = preview.reply_markup!.inline_keyboard.flat().find(item => item.callback_data.startsWith('confirm:'))!
    assert.equal(button.callback_data, `confirm:${draft.id}:1`)
    assert.ok(Buffer.byteLength(button.callback_data) <= 64)
    await callback(2, button.callback_data)
    await callback(3, button.callback_data)
    const state = await finance.state('review')
    assert.equal(state.operations.length, 1)
    assert.equal(state.operations[0]!.amount, 850_000)
    assert.equal(state.accounts[0]!.balance, -850_000)
  })
}
