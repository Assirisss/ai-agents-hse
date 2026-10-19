import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'
import { FinanceModelError, FinanceReceiptVision, recognizeReceipt } from '../finance/models.js'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore } from '../finance/store.js'

const image = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=', 'base64'), mime: 'image/png' }
const config = { model: 'test-vision', url: 'https://model.example/v1', apiKey: 'server-secret' }

test('receipt API explains provider errors without leaking bodies or writing drafts; retry uses the uploaded image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finance-vision-'))
  let status = 402
  let unexpected = false
  const vision = new FinanceReceiptVision(config, async () => status === 200
    ? Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'expense', amount: 10000, date: '2026-10-19', description: 'Тестовый чек' }) } }] })
    : Response.json({ error: { message: 'server-secret private provider body' } }, { status }))
  const store = new MemoryFinanceStore()
  const finance = new FinanceService(store, undefined, {
    text: false, vision: true, async run() { throw new Error('unused') },
    async recognize(bytes, mime) {
      if (unexpected) throw new Error('server-secret private adapter error')
      return recognizeReceipt({ bytes, mime }, { vision })
    },
  }, { receiptDir: directory })
  const app = createApp(undefined, { finance })
  try {
    const uploaded = await app.inject({ method: 'POST', url: '/api/finance/receipts?profileId=review', headers: { 'content-type': image.mime }, payload: image.bytes })
    assert.equal(uploaded.statusCode, 200)
    const id = uploaded.json().id
    const url = `/api/finance/receipts/${id}/recognize?profileId=review`
    const before = await store.read('review')
    for (const [code, message] of [[402, /Недостаточно средств/], [401, /API-ключ/], [403, /Нет доступа/], [404, /не найдены/], [429, /лимит/], [503, /временно недоступна/]] as const) {
      status = code
      const response = await app.inject({ method: 'POST', url })
      assert.equal(response.statusCode, 502)
      assert.match(response.json().error, message)
      assert.match(response.json().error, new RegExp(`HTTP ${code}`))
      assert.doesNotMatch(response.body, /server-secret|private provider|исследований|issues/)
      assert.deepEqual(await store.read('review'), before)
    }
    unexpected = true
    const unknown = await app.inject({ method: 'POST', url })
    assert.equal(unknown.statusCode, 502)
    assert.match(unknown.json().error, /Не удалось распознать чек/)
    assert.doesNotMatch(unknown.body, /server-secret|private adapter/)
    assert.deepEqual(await store.read('review'), before)

    unexpected = false; status = 200
    const retry = await app.inject({ method: 'POST', url })
    assert.equal(retry.statusCode, 200)
    assert.equal(retry.json().status, 'pending')
    assert.equal(retry.json().receiptId, id)
    assert.equal(retry.json().amount, 10000)
    const state = await finance.state('review')
    assert.equal(state.drafts.length, 1)
    assert.equal(state.operations.length, 0)
    assert.equal(state.accounts[0]!.balance, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('invalid model responses are upstream errors rather than invalid user parameters', async () => {
  for (const payload of [
    'server-secret not JSON',
    JSON.stringify({ error: { message: 'server-secret' } }),
    JSON.stringify({ choices: [{ message: { content: 'server-secret not a receipt' } }] }),
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ amount: 1.5, accountId: 'server-secret' }) } }] }),
  ]) {
    const vision = new FinanceReceiptVision(config, async () => new Response(payload))
    await assert.rejects(recognizeReceipt(image, { vision }), (error: Error) => {
      assert.ok(error instanceof FinanceModelError)
      assert.equal(error.statusCode, 502)
      assert.doesNotMatch(error.message, /server-secret/)
      return true
    })
  }
})

test('vision network errors are redacted and recognition cancellation returns a timeout', async () => {
  const vision = new FinanceReceiptVision(config, async () => { throw new Error('server-secret connection error') })
  await assert.rejects(recognizeReceipt(image, { vision }), (error: Error) => {
    assert.ok(error instanceof FinanceModelError)
    assert.equal(error.statusCode, 502)
    assert.equal(error.message, 'Финансовая модель недоступна')
    return true
  })
  const controller = new AbortController()
  const pending = recognizeReceipt(image, { signal: controller.signal, vision: { async recognize() { return new Promise(() => {}) } } })
  controller.abort()
  await assert.rejects(pending, (error: Error) => {
    assert.ok(error instanceof FinanceModelError)
    assert.equal(error.statusCode, 504)
    return true
  })
})

test('unexpected finance failures have a finance message without exposing internals', async () => {
  const store = new MemoryFinanceStore()
  store.read = async () => { throw new Error('server-secret database error') }
  const app = createApp(undefined, { finance: new FinanceService(store) })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/finance/state' })
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error, 'Ошибка финансового сервиса')
    assert.doesNotMatch(response.body, /server-secret|database|исследований/)
  } finally { await app.close() }
})
