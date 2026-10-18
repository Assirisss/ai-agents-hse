import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserWardrobeRepository } from '../../../frontend/src/modules/wardrobe/repository.js'
import { createChatAssets } from '../../../frontend/src/modules/wardrobe/chatAssets.js'
import { createChatToolExecutor } from '../../../frontend/src/modules/wardrobe/chatTools.js'
import { askStylist, readAgentSnapshot } from '../../../frontend/src/modules/wardrobe/agentClient.js'
import { WardrobeAgentService } from '../wardrobe/agent.js'
import type { ResearchPlanner, AgentMessage, ToolCall } from '../trends/planner.js'
import type { WardrobeChatRequest, WardrobePhotoInspection } from '../../../shared/wardrobe-agent.js'
import type { WardrobeClientCall, WardrobeClientResult } from '../../../shared/wardrobe-tools.js'
import { clientToolSchemas } from '../wardrobe/client-schema.js'
import { createApp } from '../app.js'
import { TrendResearchService } from '../trends/service.js'
import { TrendMemory } from '../trends/memory.js'

const fields = { name: 'Белая футболка', category: 'tops' as const, color: 'white' as const, season: 'all' as const, brand: '', notes: 'Круглый вырез' }
const finish: ToolCall = { name: 'wardrobe_finish', arguments: { text: 'Готово.', sourceIds: [] } }
const last = (messages: AgentMessage[], name: string) => JSON.parse(messages.filter(message => message.tool_name === name).at(-1)!.content)
function planner(next: (messages: AgentMessage[], round: number) => ToolCall[]): ResearchPlanner {
  let round = 0
  return { provider: 'test', async next(messages) { return { content: '', calls: next(messages, round++) } } }
}
async function setup() {
  const repository = createBrowserWardrobeRepository(`tool-test-${crypto.randomUUID()}`)
  const assets = createChatAssets(repository.namespace)
  const id = crypto.randomUUID()
  const original = new Blob(['original photo'], { type: 'image/jpeg' })
  await assets.put({ id, name: 'IMG_1938.JPG', photo: { original, display: original, processing: 'original' }, createdAt: new Date().toISOString() })
  let inspections = 0
  const inspect = async (): Promise<WardrobePhotoInspection> => { inspections++; return { id, status: 'recognized', draft: fields, description: 'Белая футболка.', uncertainties: [], provider: 'test' } }
  const request: WardrobeChatRequest = { message: 'Убери фон и добавь вещь', turnId: crypto.randomUUID(), history: [], snapshot: await readAgentSnapshot(repository), today: new Date().toISOString().slice(0, 10), allowTrends: false, trendTopic: 'мода', attachments: [{ id, name: 'Фото', processing: 'original' }] }
  const apply = repository.applyAgentAction.bind(repository)
  return { repository, assets, id, original, inspect, apply, request, inspections: () => inspections }
}
const active = () => new AbortController().signal

void test('the model chooses inspect without adding; an attachment alone never runs tools', async () => {
  const s = await setup()
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id] })
    await new WardrobeAgentService(planner(() => [finish])).chat(s.request, active(), undefined, execute)
    assert.equal(s.inspections(), 0)
    const reply = await new WardrobeAgentService(planner((_messages, round) => round === 0 ? [{ name: 'wardrobe_inspect_image', arguments: { imageId: s.id } }] : [finish])).chat({ ...s.request, message: 'Что на фотографии?' }, active(), undefined, execute)
    assert.equal(reply.trace[0].status, 'ok')
    assert.equal(s.inspections(), 1)
    assert.equal((await s.repository.list()).length, 0)
  } finally { await s.assets.close() }
})

void test('model-selected remove → add uses the returned image, fills fields internally and deduplicates calls', async () => {
  const s = await setup()
  let removals = 0
  const display = new Blob(['transparent png'], { type: 'image/png' })
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id], removeBackground: async original => { removals++; return { original, display, processing: 'background-removed' } } })
    const model = planner((messages, round) => {
      if (round === 0) return [{ name: 'wardrobe_remove_background', arguments: { imageId: s.id } }]
      if (round === 1) {
        const imageId = last(messages, 'wardrobe_remove_background').image.id
        return [1, 2].map(n => ({ id: `different-${n}`, name: 'wardrobe_add_from_image', arguments: { imageId } }))
      }
      if (round === 2) {
        assert.equal(last(messages, 'wardrobe_add_from_image').garment.name, fields.name)
        return [{ name: 'wardrobe_search', arguments: {} }]
      }
      assert.equal(last(messages, 'wardrobe_search').items.length, 1)
      return [finish]
    })
    const reply = await new WardrobeAgentService(model).chat(s.request, active(), undefined, execute)
    assert.equal(reply.status, 'completed')
    assert.ok(reply.trace.every(step => step.status === 'ok'))
    const [saved] = await s.repository.list()
    assert.equal(saved.name, fields.name)
    assert.equal(saved.photo.processing, 'background-removed')
    assert.equal(await saved.photo.original.text(), await s.original.text())
    assert.equal(await saved.photo.display.text(), await display.text())
    assert.equal(s.inspections(), 1)
    assert.equal(removals, 1)
    assert.equal((await s.repository.list()).length, 1)
  } finally { await s.assets.close() }
})

void test('update and photo replacement preserve unrelated fields and reject stale versions', async () => {
  const s = await setup()
  try {
    const receipts: WardrobeClientResult[] = []
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id], onResult: result => receipts.push(result) })
    const added = await execute({ id: 'add', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, active())
    const garment = added.garment!
    await execute({ id: 'edit', name: 'wardrobe_update_garment', arguments: { garmentId: garment.id, expectedUpdatedAt: garment.updatedAt, changes: { notes: 'Для прогулок' } } }, active())
    const [updated] = await s.repository.list()
    assert.equal(updated.name, fields.name)
    assert.equal(updated.notes, 'Для прогулок')
    assert.equal(await updated.photo.original.text(), 'original photo')
    const replacementId = crypto.randomUUID()
    const replacement = new Blob(['new photo'], { type: 'image/jpeg' })
    await s.assets.put({ id: replacementId, name: 'new.jpg', photo: { original: replacement, display: replacement, processing: 'original' }, createdAt: new Date().toISOString() })
    const other = createChatToolExecutor({ ...s, allowedImageIds: [replacementId] })
    await assert.rejects(() => other({ id: 'stale', name: 'wardrobe_replace_photo', arguments: { garmentId: garment.id, expectedUpdatedAt: '2020-01-01T00:00:00Z', imageId: replacementId } }, active()), /изменилась/)
    await other({ id: 'replace', name: 'wardrobe_replace_photo', arguments: { garmentId: garment.id, expectedUpdatedAt: updated.updatedAt, imageId: replacementId } }, active())
    const [saved] = await s.repository.list()
    assert.equal(saved.notes, 'Для прогулок')
    assert.equal(await saved.photo.original.text(), 'new photo')
    assert.equal(receipts.length, 2)
  } finally { await s.assets.close() }
})

void test('ambiguous recognition, foreign images and cancellation cannot create garments', async () => {
  const s = await setup()
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id], inspect: async () => ({ id: s.id, status: 'needs_clarification', draft: null, description: 'Добавить куртку или брюки?', uncertainties: [], provider: 'test' }) })
    const result = await execute({ id: 'unclear', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, active())
    assert.equal(result.ok, false)
    assert.match(result.error!, /куртку или брюки/)
    await assert.rejects(() => execute({ id: 'foreign', name: 'wardrobe_inspect_image', arguments: { imageId: crypto.randomUUID() } }, active()), /не относится/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => execute({ id: 'cancelled', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, controller.signal))
    assert.equal((await s.repository.list()).length, 0)
    assert.equal(clientToolSchemas.wardrobe_update_garment.safeParse({ garmentId: 'x', expectedUpdatedAt: new Date().toISOString(), changes: { id: 'overwrite' } }).success, false)
  } finally { await s.assets.close() }
})

void test('a completed write remains acknowledged when the next model call fails', async () => {
  const s = await setup()
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id] })
    const model = planner((_messages, round) => { if (round) throw new Error('model unavailable'); return [{ name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }] })
    const reply = await new WardrobeAgentService(model).chat(s.request, active(), undefined, execute)
    assert.equal(reply.status, 'limited')
    assert.match(reply.text, /добавлена/)
    assert.equal((await s.repository.list()).length, 1)
  } finally { await s.assets.close() }
})

void test('real HTTP stream round-trips browser tools and single-use results with the same call id', async () => {
  const s = await setup()
  const service = new TrendResearchService(undefined, undefined, undefined, { memory: new TrendMemory(':memory:') })
  const app = createApp(service, undefined, planner((_messages, round) => round === 0 ? [{ name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }] : [finish]))
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const actualFetch = globalThis.fetch
  let token = ''
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/tool-results/')) token = String(url).split('/').at(-1)!
    return actualFetch(new URL(String(url), origin), init)
  }
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id] })
    const reply = await askStylist(s.request, active(), undefined, execute)
    assert.equal(reply.status, 'completed')
    assert.equal((await s.repository.list()).length, 1)
    assert.ok(token)
    assert.equal((await actualFetch(`${origin}/api/wardrobe/agent/tool-results/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'x', result: { ok: true } }) })).status, 404)
  } finally { globalThis.fetch = actualFetch; await s.assets.close(); await app.close() }
})

void test('attachments and processed images survive a new connection without entering the garment catalog', async () => {
  const s = await setup()
  await s.assets.close()
  const reopened = createChatAssets(s.repository.namespace)
  try {
    assert.equal(await (await reopened.get(s.id))!.photo.original.text(), 'original photo')
    assert.equal((await s.repository.list()).length, 0)
  } finally { await reopened.close() }
})

void test('repeating addition in another chat turn never duplicates the same attachment', async () => {
  const s = await setup()
  try {
    const first = createChatToolExecutor({ ...s, allowedImageIds: [s.id] })
    await first({ id: 'first-turn', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, active())
    const second = createChatToolExecutor({ ...s, allowedImageIds: [s.id] })
    await second({ id: 'second-turn', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, active())
    assert.equal((await s.repository.list()).length, 1)
  } finally { await s.assets.close() }
})

void test('save failure never emits a success receipt; cancellation during a committed write does', async () => {
  const s = await setup()
  try {
    const observed: WardrobeClientResult[] = []
    const failed = createChatToolExecutor({ ...s, allowedImageIds: [s.id], apply: async () => { throw new Error('storage full') }, onResult: result => observed.push(result) })
    await assert.rejects(() => failed({ id: 'failed', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, active()), /storage full/)
    assert.equal(observed.length, 0)
    assert.equal((await s.repository.list()).length, 0)
    const controller = new AbortController()
    const committed = createChatToolExecutor({ ...s, allowedImageIds: [s.id], apply: async (action, photo) => { const result = await s.apply(action, photo); controller.abort(); return result }, onResult: result => observed.push(result) })
    const result = await committed({ id: 'committed', name: 'wardrobe_add_from_image', arguments: { imageId: s.id } }, controller.signal)
    assert.equal(result.ok, true)
    assert.equal(observed.length, 1)
    assert.equal((await s.repository.list()).length, 1)
  } finally { await s.assets.close() }
})

void test('disconnect cleans pending tool tokens and releases the active model run', async () => {
  const s = await setup()
  const service = new TrendResearchService(undefined, undefined, undefined, { memory: new TrendMemory(':memory:') })
  const app = createApp(service, undefined, planner(() => [{ name: 'wardrobe_inspect_image', arguments: { imageId: s.id } }]))
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`${origin}/api/wardrobe/agent/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.request) })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('tool_request')) text += new TextDecoder().decode((await reader.read()).value)
    const event = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'tool_request')
    const mismatch = await fetch(`${origin}/api/wardrobe/agent/tool-results/${event.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'wrong-id', result: { ok: true } }) })
    assert.equal(mismatch.status, 409)
    await reader.cancel()
    const deadline = Date.now() + 1000
    let status = 409
    while (status !== 404 && Date.now() < deadline) {
      status = (await fetch(`${origin}/api/wardrobe/agent/tool-results/${event.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'wrong-id', result: { ok: true } }) })).status
      if (status !== 404) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(status, 404)
  } finally { await s.assets.close(); app.server.closeAllConnections(); await app.close() }
})

void test('trend tool sends the public topic selected from chat to the existing research agent', async () => {
  const s = await setup()
  try {
    let query = ''
    const model = planner((_messages, round) => round === 0 ? [{ name: 'wardrobe_search_trends', arguments: { topic: 'осенние сумки 2026', focus: 'accessories' } }] : [finish])
    const agent = new WardrobeAgentService(model, async input => { query = input.query; throw new Error('test stops before network') })
    await agent.chat({ ...s.request, allowTrends: true })
    assert.equal(query, 'осенние сумки 2026 аксессуары')
    assert.ok(!query.includes(fields.name))
  } finally { await s.assets.close() }
})

void test('vision outage after background removal stays in chat; the next turn saves the cutout without repeating CV', async () => {
  const { PhotoInspectionError } = await import('../../../frontend/src/modules/wardrobe/chatPhotos.js')
  const s = await setup()
  let cutoutId = ''
  let removals = 0
  const display = new Blob(['transparent image'], { type: 'image/png' })
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id], inspect: async () => { throw new PhotoInspectionError('Сервис недоступен', true) }, removeBackground: async original => { removals++; return { original, display, processing: 'background-removed' } }, onResult: result => { if (result.image) cutoutId = result.image.id } })
    const model = planner((messages, round) => {
      if (round === 0) return [{ name: 'wardrobe_remove_background', arguments: { imageId: s.id } }]
      if (round === 1) return [{ name: 'wardrobe_add_from_image', arguments: { imageId: last(messages, 'wardrobe_remove_background').image.id } }]
      assert.equal(last(messages, 'wardrobe_add_from_image').retryable, true)
      assert.equal(last(messages, 'wardrobe_add_from_image').image.id, cutoutId)
      return [{ name: 'wardrobe_finish', arguments: { text: `Фон удалён: ${cutoutId}. Добавьте вручную через форму. Предложить образ?`, sourceIds: [] } }]
    })
    const reply = await new WardrobeAgentService(model).chat(s.request, active(), undefined, execute)
    assert.equal(reply.status, 'limited')
    assert.match(reply.text, /повтори добавление/)
    assert.ok(!/вручную|форму|Предложить образ|cutout-/.test(reply.text))
    assert.equal(reply.trace[1].status, 'error')
    assert.equal((await s.repository.list()).length, 0)
    const next = createChatToolExecutor({ ...s, allowedImageIds: [cutoutId], removeBackground: async () => { throw new Error('CV must not run again') } })
    const result = await next({ id: 'retry-next-turn', name: 'wardrobe_add_from_image', arguments: { imageId: cutoutId } }, active())
    assert.equal(result.ok, true)
    assert.equal(removals, 1)
    const [saved] = await s.repository.list()
    assert.equal(await saved.photo.display.text(), 'transparent image')
    assert.equal(await saved.photo.original.text(), 'original photo')
  } finally { await s.assets.close() }
})

void test('recognized fields survive another turn and background removal without a second vision call', async () => {
  const s = await setup()
  let cutoutId = ''
  try {
    const execute = createChatToolExecutor({ ...s, allowedImageIds: [s.id], removeBackground: async original => ({ original, display: new Blob(['cutout'], { type: 'image/png' }), processing: 'background-removed' }) })
    await execute({ id: 'inspect-first', name: 'wardrobe_inspect_image', arguments: { imageId: s.id } }, active())
    const cleaned = await execute({ id: 'remove-after-inspect', name: 'wardrobe_remove_background', arguments: { imageId: s.id } }, active())
    cutoutId = cleaned.image!.id
    const next = createChatToolExecutor({ ...s, allowedImageIds: [cutoutId], inspect: async () => { throw new Error('Recognition was already saved') } })
    const result = await next({ id: 'add-later', name: 'wardrobe_add_from_image', arguments: { imageId: cutoutId } }, active())
    assert.equal(result.ok, true)
    assert.equal(s.inspections(), 1)
    assert.equal((await s.repository.list()).length, 1)
  } finally { await s.assets.close() }
})

void test('assistant text never exposes internal image handles even when a model includes them', async () => {
  const { wardrobeDisplayText } = await import('../../../shared/wardrobe-display.mjs')
  assert.equal(wardrobeDisplayText('Готово: `cutout-' + 'a'.repeat(64) + '`.'), 'Готово: фото без фона.')
  const s = await setup()
  try {
    const reply = await new WardrobeAgentService(planner(() => [{ name: 'wardrobe_finish', arguments: { text: 'Фон удалён: cutout-' + 'b'.repeat(64), sourceIds: [] } }])).chat(s.request)
    assert.equal(reply.text, 'Фон удалён: фото без фона')
  } finally { await s.assets.close() }
})

void test('a cleaned photo is not sent to CV again and an already-added photo needs no vision service', async () => {
  const s = await setup()
  let removals = 0
  try {
    const first = createChatToolExecutor({ ...s, allowedImageIds: [s.id], removeBackground: async original => { removals++; return { original, display: new Blob(['cutout'], { type: 'image/png' }), processing: 'background-removed' } } })
    const cleaned = await first({ id: 'first-cutout', name: 'wardrobe_remove_background', arguments: { imageId: s.id } }, active())
    const imageId = cleaned.image!.id
    await first({ id: 'first-add', name: 'wardrobe_add_from_image', arguments: { imageId } }, active())
    const next = createChatToolExecutor({ ...s, allowedImageIds: [imageId], inspect: async () => { throw new Error('vision unavailable') }, removeBackground: async () => { throw new Error('CV must not run twice') } })
    const repeatedCutout = await next({ id: 'repeat-cutout', name: 'wardrobe_remove_background', arguments: { imageId } }, active())
    assert.equal(repeatedCutout.image!.id, imageId)
    const repeatedAdd = await next({ id: 'repeat-add', name: 'wardrobe_add_from_image', arguments: { imageId } }, active())
    assert.equal(repeatedAdd.ok, true)
    assert.equal((await s.repository.list()).length, 1)
    assert.equal(removals, 1)
  } finally { await s.assets.close() }
})
