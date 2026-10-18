/** Live model chooses tools; synthetic image, isolated IndexedDB, no personal data. */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { createBrowserWardrobeRepository } from '../../frontend/src/modules/wardrobe/repository.ts'
import { createChatAssets } from '../../frontend/src/modules/wardrobe/chatAssets.ts'
import { createChatToolExecutor } from '../../frontend/src/modules/wardrobe/chatTools.ts'
import { askStylist, readAgentSnapshot } from '../../frontend/src/modules/wardrobe/agentClient.ts'
const origin = process.env.WARDROBE_TEST_ORIGIN || 'http://127.0.0.1:5175'
const transport = globalThis.fetch
globalThis.fetch = (url, options) => transport(new URL(url, origin), options)
const repository = createBrowserWardrobeRepository(`live-tool-check-${crypto.randomUUID()}`)
const assets = createChatAssets(repository.namespace)
const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#e6e6e6"/><path d="M135 65 L65 125 L100 205 L135 180 L135 420 L265 420 L265 180 L300 205 L335 125 L265 65 L235 80 Q200 115 165 80 Z" fill="white" stroke="#444" stroke-width="4"/></svg>')).jpeg().toBuffer()
const original = new Blob([bytes], { type: 'image/jpeg' })
const id = crypto.randomUUID()
await assets.put({ id, name: 'test-shirt.jpg', photo: { original, display: original, processing: 'original' }, createdAt: new Date().toISOString() })
const execute = createChatToolExecutor({ repository, assets, allowedImageIds: [id], apply: (action, photo) => repository.applyAgentAction(action, photo), inspect: async (item, message, signal) => {
  const response = await fetch('/api/wardrobe/agent/photos/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ id: item.id, message, image: `data:image/jpeg;base64,${bytes.toString('base64')}` }) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}, onResult: result => console.log(JSON.stringify({ tool: result.receipt?.tool, saved: Boolean(result.garment), status: result.inspection?.status })) })
try {
  const reply = await askStylist({ message: 'Добавь эту футболку в гардероб. Фон не меняй.', turnId: crypto.randomUUID(), history: [], snapshot: await readAgentSnapshot(repository), today: new Date().toISOString().slice(0, 10), allowTrends: false, trendTopic: 'мода', attachments: [{ id, name: 'test-shirt.jpg', processing: 'original' }] }, new AbortController().signal, event => console.log(JSON.stringify(event)), execute)
  const garments = await repository.list()
  assert.equal(garments.length, 1, JSON.stringify({ text: reply.text, trace: reply.trace, warnings: reply.warnings }))
  assert.equal(garments[0].category, 'tops')
  assert.deepEqual(Buffer.from(await garments[0].photo.original.arrayBuffer()), bytes)
  assert.ok(reply.trace.some(step => step.tool === 'wardrobe_add_from_image' && step.status === 'ok'))
  console.log(JSON.stringify({ status: 'PASS', text: reply.text, tools: reply.trace, saved: garments.length, originalBytes: bytes.length, provider: reply.provider, database: 'isolated fake-indexeddb' }, null, 2))
} finally { await assets.close() }
