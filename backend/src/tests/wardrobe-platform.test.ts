import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createBrowserWardrobeRepository } from '../../../frontend/src/modules/wardrobe/repository.js'
import { askStylist, conversationHistory, readAgentSnapshot } from '../../../frontend/src/modules/wardrobe/agentClient.js'
import { localDate } from '../../../frontend/src/modules/wardrobe/outfitDomain.js'
import type { Garment } from '../../../frontend/src/modules/wardrobe/types.js'
import type { WardrobeAction, WardrobeChatMessage } from '../../../shared/wardrobe-agent.js'
import { WardrobeAgentService } from '../wardrobe/agent.js'
import { runOutfitChecks } from '../../../frontend/tests/outfits.browser.js'
import { runWishlistChecks } from '../../../frontend/tests/wishlist.browser.js'

const photo = () => { const image = new Blob(['synthetic-photo-bytes'], { type: 'image/png' }); return { original: image, display: image, processing: 'original' as const } }
const garment = (): Garment => ({ id: 'shirt', name: 'Рубашка', category: 'tops', color: 'white', season: 'all', brand: 'Мой бренд', notes: '', photo: photo(), createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z' })
async function setup() {
  const repository = createBrowserWardrobeRepository(`stylist-test-${randomUUID()}`)
  await repository.save(garment())
  return repository
}
const outfit = (id = randomUUID()): WardrobeAction => ({ id, kind: 'outfit', name: 'Прогулка', garmentIds: ['shirt'], notes: '', reason: 'Знакомая рубашка' })

void test('reviewed chat cards apply atomically and remain idempotent across concurrent requests and new connections', async () => {
  const repository = await setup()
  const action = outfit()
  await Promise.all([repository.applyAgentAction(action), repository.applyAgentAction(action)])
  const items = await repository.listOutfits()
  assert.equal(items.length, 1)
  assert.equal(items[0].layers[0].garmentId, 'shirt')
  const reopened = createBrowserWardrobeRepository(repository.namespace)
  assert.match(await reopened.applyAgentAction(action), /уже выполнено/)
  assert.equal((await reopened.listOutfits()).length, 1)
  await repository.removeOutfit(items[0].id)
  await repository.applyAgentAction(action)
  assert.equal((await repository.listOutfits()).length, 0, 'An old card must not resurrect a deleted outfit')
})

void test('failed cards leave no receipt and can be retried after the missing data is restored', async () => {
  const repository = await setup()
  const action = outfit()
  await repository.remove('shirt')
  await assert.rejects(() => repository.applyAgentAction(action), /Состав/)
  assert.equal((await repository.listOutfits()).length, 0)
  await repository.save(garment())
  await repository.applyAgentAction(action)
  assert.equal((await repository.listOutfits()).length, 1)
})

void test('stale updates and deleted clothes cannot be overwritten; photos survive successful edits', async () => {
  const repository = await setup()
  const previous = garment()
  const action: WardrobeAction = { id: randomUUID(), kind: 'update', garmentId: 'shirt', expectedUpdatedAt: previous.updatedAt, draft: { name: 'Новое имя', category: 'tops', color: 'beige', season: 'all', brand: previous.brand, notes: 'Обновлённая заметка' }, reason: 'По просьбе пользователя' }
  await repository.save({ ...previous, name: 'Изменено вручную', updatedAt: '2026-10-18T11:00:00Z' })
  await assert.rejects(() => repository.applyAgentAction(action), /изменилась/)
  assert.equal((await repository.list())[0].name, 'Изменено вручную')
  await repository.applyAgentAction({ ...action, expectedUpdatedAt: '2026-10-18T11:00:00Z' })
  const updated = (await repository.list())[0]
  assert.equal(updated.name, 'Новое имя')
  assert.equal(updated.photo.display.size, previous.photo.display.size)
  await repository.remove('shirt')
  await assert.rejects(() => repository.applyAgentAction({ ...action, id: randomUUID() }), /удалена/)
})

void test('new garments require a real Blob and their receipt is committed only with the photo', async () => {
  const repository = await setup()
  const { photo: _photo, id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = garment()
  const action: WardrobeAction = { id: randomUUID(), kind: 'garment', draft: { ...draft, name: 'Новая рубашка' }, reason: 'Ручное добавление фото' }
  await assert.rejects(() => repository.applyAgentAction(action), /фотографию/)
  await repository.applyAgentAction(action, photo())
  await repository.applyAgentAction(action, photo())
  assert.equal((await repository.list()).length, 2)
})

void test('wishlist cards keep integer money, reject executable URLs and never create finance records', async () => {
  const repository = await setup()
  const action: WardrobeAction = { id: randomUUID(), kind: 'purchase', draft: { name: 'Сумка', category: 'bags', priceMinor: 890050, currency: 'RUB', priority: 'normal', url: 'https://example.org/bag', notes: '' }, reason: 'Дополнение коллекции' }
  await repository.applyAgentAction(action)
  await repository.applyAgentAction(action)
  assert.equal((await repository.listWishlist()).length, 1)
  assert.equal((await repository.listWishlist())[0].priceMinor, 890050)
  await assert.rejects(() => repository.applyAgentAction({ ...action, id: randomUUID(), draft: { ...action.draft, url: 'javascript:alert(1)' } }), /http/)
  assert.equal((await repository.listWishlist()).length, 1)
})

void test('wear cards check the current outfit revision, preserve snapshots and deduplicate same-day combinations', async () => {
  const repository = await setup()
  await repository.applyAgentAction(outfit())
  const saved = (await repository.listOutfits())[0]
  const action: WardrobeAction = { id: randomUUID(), kind: 'wear', outfitId: saved.id, outfitName: saved.name, expectedUpdatedAt: saved.updatedAt, date: localDate(), reason: 'Надел сегодня' }
  await Promise.all([repository.applyAgentAction(action), repository.applyAgentAction({ ...action, id: randomUUID() })])
  assert.equal((await repository.listWearEvents()).length, 1)
  assert.equal((await repository.listWearEvents())[0].garments[0].name, 'Рубашка')
  await repository.saveOutfit({ ...saved, name: 'Изменён', updatedAt: '2099-01-01T00:00:00Z' })
  await assert.rejects(() => repository.applyAgentAction({ ...action, id: randomUUID() }), /Образ изменился/)
})

void test('snapshot transport projects only approved metadata; photos and future hidden fields never leave the browser', async () => {
  const repository = await setup()
  const snapshot = await readAgentSnapshot(repository)
  assert.equal(snapshot.garments[0].name, 'Рубашка')
  assert.ok(!('photo' in snapshot.garments[0]))
  assert.ok(!('createdAt' in snapshot.garments[0]))
  assert.ok(!JSON.stringify(snapshot).includes('synthetic-photo-bytes'))
})

void test('end-to-end agent proposal → platform save → fresh snapshot → conversation receipts reflects actual state', async () => {
  const repository = await setup()
  let turn = 0
  const service = new WardrobeAgentService({ provider: 'test', async next() {
    return turn++ === 0 ? { content: '', calls: [{ name: 'wardrobe_prepare_outfit', arguments: { name: 'Прогулка', notes: '', garmentIds: ['shirt'], reason: 'Из имеющейся коллекции' } }] } : { content: '', calls: [{ name: 'wardrobe_finish', arguments: { text: 'Подготовил карточку.', sourceIds: [] } }] }
  } })
  const reply = await service.chat({ message: 'Собери образ', history: [], today: localDate(), allowTrends: false, trendTopic: 'мода', snapshot: await readAgentSnapshot(repository) })
  assert.equal((await repository.listOutfits()).length, 0)
  const message = await repository.applyAgentAction(reply.actions[0])
  assert.equal((await readAgentSnapshot(repository)).outfits.length, 1)
  const entry: WardrobeChatMessage = { id: 'reply', role: 'assistant', text: reply.text, reply, createdAt: new Date().toISOString(), results: { [reply.actions[0].id]: { status: 'applied', message } } }
  assert.match(conversationHistory([entry])[0].content, /applied/)
  assert.match(conversationHistory([entry])[0].content, /shirt/)
})

void test('wardrobe repository regression checks also pass after IndexedDB v4 migration', async t => {
  const repository = await setup()
  const check = async (name: string, action: () => Promise<void>) => { await t.test(name, action) }
  await runOutfitChecks(check, repository, garment())
  await runWishlistChecks(check, repository, garment())
})

void test('chat transport decodes split UTF-8 frames, emits progress and rejects incomplete or error streams', async () => {
  const repository = await setup()
  const request = { message: 'Привет', history: [], snapshot: await readAgentSnapshot(repository), today: localDate(), allowTrends: false, trendTopic: 'мода' }
  const reply = { text: 'Рубашка и джинсы', status: 'completed', provider: 'test', actions: [], sources: [], warnings: [], trace: [] }
  const actualFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => {
      const bytes = new TextEncoder().encode(JSON.stringify({ type: 'progress', progress: { phase: 'thinking', status: 'started' } }) + '\n' + JSON.stringify({ type: 'result', reply }))
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close() } }))
    }
    let progress = 0
    assert.equal((await askStylist(request, new AbortController().signal, () => { progress++ })).text, reply.text)
    assert.equal(progress, 1)
    globalThis.fetch = async () => new Response('{"type":"error","error":"Модель недоступна"}\n')
    await assert.rejects(() => askStylist(request, new AbortController().signal), /Модель недоступна/)
    globalThis.fetch = async () => new Response('{"type":"progress","progress":{"phase":"thinking","status":"started"}}\n')
    await assert.rejects(() => askStylist(request, new AbortController().signal), /прервался/)
  } finally { globalThis.fetch = actualFetch }
})
