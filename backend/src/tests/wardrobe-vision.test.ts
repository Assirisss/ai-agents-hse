import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { OpenRouterWardrobeVision, normalizeVisionImage } from '../wardrobe/vision.js'
import { createApp } from '../app.js'
import { TrendResearchService } from '../trends/service.js'
import { wardrobeHistory, wardrobeModelContext, estimateTokens } from '../wardrobe/context.js'
import type { AgentMessage } from '../trends/planner.js'

const draft = { name: 'Белая футболка', category: 'tops' as const, color: 'white' as const, season: 'all' as const, brand: '', notes: '' }
const result = { status: 'recognized', draft, description: 'Белая футболка с короткими рукавами.', uncertainties: [] }
async function photoRequest() {
  const image = await sharp({ create: { width: 40, height: 70, channels: 3, background: '#fff' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  return { id: randomUUID(), message: 'Добавь вещь', image: `data:image/jpeg;base64,${image.toString('base64')}` }
}
const inspector = (value: unknown = result, inspect?: (body: Record<string, unknown>) => void) => new OpenRouterWardrobeVision('private-test-key', 'openrouter/free', async (_url, init) => {
  inspect?.(JSON.parse(String(init?.body)))
  return Response.json({ model: 'test-vision', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
})

void test('vision receives a normalized photo and schema, strips EXIF and returns validated clothing fields', async () => {
  const request = await photoRequest()
  let body: Record<string, unknown> | undefined
  const reply = await inspector(result, value => { body = value }).inspect(request, new AbortController().signal)
  assert.equal(reply.id, request.id)
  assert.equal(reply.draft?.category, 'tops')
  assert.equal(reply.model, 'test-vision')
  const content = (body!.messages as { content: unknown }[])[1].content as { type: string; image_url?: { url: string } }[]
  assert.equal(content[0].type, 'text')
  const normalized = Buffer.from(content[1].image_url!.url.split(',')[1], 'base64')
  const metadata = await sharp(normalized).metadata()
  assert.equal(metadata.width, 70)
  assert.equal(metadata.height, 40)
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.orientation, undefined)
  assert.ok(!JSON.stringify(reply).includes('private-test-key'))
  assert.equal((body!.response_format as { type: string }).type, 'json_schema')
  assert.deepEqual(body!.reasoning, { enabled: false, exclude: true })
})

void test('invalid or external images are rejected before any provider request', async () => {
  let calls = 0
  const vision = inspector(result, () => { calls++ })
  const request = await photoRequest()
  await assert.rejects(() => vision.inspect({ ...request, image: 'https://localhost/private.png' }, new AbortController().signal))
  await assert.rejects(() => vision.inspect({ ...request, image: 'data:image/png;base64,YmFk' }, new AbortController().signal), /прочитать/)
  await assert.rejects(() => vision.inspect({ ...request, image: request.image.replace('image/jpeg', 'image/png') }, new AbortController().signal), /прочитать/)
  assert.equal(calls, 0)
})

void test('unclear photos do not become invented clothes; invalid fields and truncated outputs fail explicitly', async () => {
  const request = await photoRequest()
  const unclear = await inspector({ status: 'needs_clarification', draft: null, description: 'Какую из двух вещей добавить?', uncertainties: ['На фото две вещи'] }).inspect(request, new AbortController().signal)
  assert.equal(unclear.draft, null)
  await assert.rejects(() => inspector({ ...result, draft: { ...draft, category: 'invented' } }).inspect(request, new AbortController().signal), /характеристики/)
  await assert.rejects(() => inspector({ ...result, draft: null }).inspect(request, new AbortController().signal), /характеристики/)
  const truncated = new OpenRouterWardrobeVision('test-key', 'test-model', async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"status":' } }] }))
  await assert.rejects(() => truncated.inspect(request, new AbortController().signal), /не завершилось/)
})

void test('a vision model cannot report a successful platform write in its free-form description', async () => {
  const reply = await inspector({ ...result, description: 'Я успешно добавила эту вещь в гардероб.' }).inspect(await photoRequest(), new AbortController().signal)
  assert.ok(!/добавила|сохран/i.test(reply.description))
  assert.match(reply.description, /Белая футболка/)
})

void test('vision provider failures preserve safe reasons, never retry and never leak provider bodies', async () => {
  const request = await photoRequest()
  for (const status of [401, 429, 503]) {
    let calls = 0
    const vision = new OpenRouterWardrobeVision('secret', 'openrouter/free', async () => { calls++; return new Response('private body with secret', { status }) })
    await assert.rejects(() => vision.inspect(request, new AbortController().signal), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes('secret'))
      assert.ok(!error.message.includes('private body'))
      return true
    })
    assert.equal(calls, 1)
  }
  await assert.rejects(() => new OpenRouterWardrobeVision('').inspect(request, new AbortController().signal), /не подключено/)
})

void test('vision API accepts image-sized JSON and exposes its capability alongside the text agent', async () => {
  const app = createApp(new TrendResearchService(), { vision: inspector() })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/wardrobe/agent/photos/inspect', payload: await photoRequest() })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().draft.name, draft.name)
    const caps = await app.inject({ url: '/api/wardrobe/agent/capabilities' })
    assert.equal(caps.json().vision.configured, true)
    const invalid = await app.inject({ method: 'POST', url: '/api/wardrobe/agent/photos/inspect', payload: {} })
    assert.equal(invalid.statusCode, 400)
  } finally { await app.close() }
})

void test('large wardrobe histories and tool results remain bounded, valid JSON and complete tool groups', () => {
  const history = wardrobeHistory(Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'Личная история '.repeat(400) })))
  assert.ok(estimateTokens(JSON.stringify(history)) < 3000)
  const messages: AgentMessage[] = [{ role: 'system', content: 'Ты стилист.' }, ...history, { role: 'user', content: 'Найди вещи' }]
  for (let round = 0; round < 5; round++) messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `call-${round}`, function: { name: 'wardrobe_search', arguments: {} } }] }, { role: 'tool', tool_call_id: `call-${round}`, content: JSON.stringify({ items: Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, notes: 'Большая заметка '.repeat(70) })) }) })
  const context = wardrobeModelContext(messages)
  assert.ok(estimateTokens(JSON.stringify(context)) < 8500)
  for (const message of context) if (message.role === 'tool') {
    assert.doesNotThrow(() => JSON.parse(message.content))
    assert.ok(context.some(item => item.tool_calls?.some(call => call.id === message.tool_call_id)))
  }
})

void test('default vision uses a bounded free fallback route and reports the model actually used', async () => {
  let calls = 0
  const vision = new OpenRouterWardrobeVision('secret', 'dots-studio/dots-3-note-preview:free', async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.models, ['dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-super-vl:free'])
    assert.ok(body.models.every((model: string) => model.endsWith(':free')))
    assert.equal(body.model, undefined)
    return Response.json({ model: body.models[1], choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] })
  })
  const reply = await vision.inspect(await photoRequest(), new AbortController().signal)
  assert.equal(reply.model, 'nvidia/nemotron-3.5-super-vl:free')
  assert.equal(calls, 1)
})

void test('vision API exposes a safe recoverable error while invalid credentials are not retryable', async () => {
  for (const status of [503, 401]) {
    const vision = new OpenRouterWardrobeVision('secret', 'test-model', async () => new Response('private provider details', { status }))
    const app = createApp(new TrendResearchService(), { vision })
    try {
      const response = await app.inject({ method: 'POST', url: '/api/wardrobe/agent/photos/inspect', payload: await photoRequest() })
      assert.equal(response.json().retryable, status === 503)
      assert.equal(response.json().code, 'vision_unavailable')
      assert.ok(!response.body.includes('private provider details'))
    } finally { await app.close() }
  }
})
