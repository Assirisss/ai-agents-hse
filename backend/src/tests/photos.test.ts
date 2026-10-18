import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../app.js'
import { RunpodBiRefNet, PhotoProcessingError, type BackgroundRemover } from '../wardrobe/photos.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==', 'base64')
const route = '/api/wardrobe/photos/remove-background'
const job = { id: 'test-job-u1', status: 'queued' as const }

void test('photo API accepts binary input, returns a job, status and a separate PNG', async () => {
  let cancelled = false
  const remover: BackgroundRemover = {
    configured: true,
    async start(bytes, type) { assert.deepEqual(bytes, png); assert.equal(type, 'image/png'); return job },
    async status(id) { assert.equal(id, job.id); return { ...job, status: 'succeeded' } },
    async result(id) { assert.equal(id, job.id); return png },
    async cancel(id) { assert.equal(id, job.id); cancelled = true },
  }
  const app = createApp(undefined, remover)
  try {
    assert.deepEqual((await app.inject('/api/wardrobe/photos/capabilities')).json(), { provider: 'birefnet', configured: true })
    const created = await app.inject({ method: 'POST', url: route, headers: { 'content-type': 'image/png' }, payload: png })
    assert.equal(created.statusCode, 202)
    assert.deepEqual(created.json(), job)
    const status = await app.inject(`/api/wardrobe/photos/jobs/${job.id}`)
    assert.equal(status.json().status, 'succeeded')
    const result = await app.inject(`/api/wardrobe/photos/jobs/${job.id}/result`)
    assert.equal(result.headers['content-type'], 'image/png')
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.deepEqual(result.rawPayload, png)
    assert.equal((await app.inject({ method: 'POST', url: `/api/wardrobe/photos/jobs/${job.id}/cancel` })).statusCode, 204)
    assert.equal(cancelled, true)
  } finally { await app.close() }
})

void test('photo API rejects unsupported, empty, oversized and foreign-origin input before inference', async () => {
  let calls = 0
  const remover = new RunpodBiRefNet()
  remover.start = async () => { calls++; return job }
  const app = createApp(undefined, remover)
  try {
    for (const [headers, payload, status] of [
      [{ 'content-type': 'application/json' }, '{}', 415],
      [{ 'content-type': 'image/png' }, Buffer.alloc(0), 400],
      [{ 'content-type': 'image/png' }, Buffer.alloc(6 * 1024 * 1024 + 1), 413],
      [{ 'content-type': 'image/png', origin: 'https://example.com' }, png, 403],
    ] as const) {
      assert.equal((await app.inject({ method: 'POST', url: route, headers, payload })).statusCode, status)
    }
    assert.equal(calls, 0)
    assert.equal((await app.inject({ method: 'POST', url: '/api/trends/research', payload: { query: 'a'.repeat(9000) } })).statusCode, 413)
  } finally { await app.close() }
})

void test('Runpod adapter submits Flash input with server credentials, polls, caches PNG and cancels', async () => {
  const calls: string[] = []
  const adapter = new RunpodBiRefNet('endpoint-test', 'server-secret', async (url, options) => {
    calls.push(String(url))
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer server-secret')
    if (String(url).endsWith('/run')) {
      const body = JSON.parse(options?.body as string)
      assert.equal(body.input.input_data.image_base64, png.toString('base64'))
      assert.equal(body.input.input_data.mime_type, 'image/png')
      assert.equal(body.policy.executionTimeout, 180_000)
      return Response.json({ id: job.id, status: 'IN_QUEUE' })
    }
    if (String(url).includes('/cancel/')) return Response.json({ id: job.id, status: 'CANCELLED' })
    return Response.json({ id: job.id, status: 'COMPLETED', output: { image_base64: png.toString('base64') } })
  })
  assert.equal(adapter.configured, true)
  assert.deepEqual(await adapter.start(png, 'image/png'), job)
  await assert.rejects(adapter.result(job.id), (e: unknown) => e instanceof PhotoProcessingError && e.statusCode === 409)
  assert.equal((await adapter.status(job.id)).status, 'succeeded')
  assert.deepEqual(await adapter.result(job.id), png)
  assert.equal((await adapter.status(job.id)).status, 'succeeded')
  assert.equal(calls.length, 2, 'Completed PNG should not be downloaded again')
  await adapter.cancel(job.id)
  await assert.rejects(adapter.status(job.id), (e: unknown) => e instanceof PhotoProcessingError && e.statusCode === 404)
  assert.equal(calls.length, 3)
})

void test('Runpod job states include queue, running, terminal failure and cancellation', async () => {
  for (const [remote, expected] of [['IN_QUEUE', 'queued'], ['IN_PROGRESS', 'running'], ['FAILED', 'failed'], ['TIMED_OUT', 'failed'], ['CANCELLED', 'cancelled'], ['COMPLETED', 'failed']] as const) {
    const adapter = new RunpodBiRefNet('test', 'secret', async url => Response.json(String(url).endsWith('/run') ? { id: job.id } : { status: remote, error: 'private trace with secret', output: { error: 'invalid image' } }))
    await adapter.start(png, 'image/png')
    const result = await adapter.status(job.id)
    assert.equal(result.status, expected)
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
})

void test('missing config, HTTP failures, invalid PNG and unknown jobs fail without leaking provider data', async () => {
  const missing = new RunpodBiRefNet('', '')
  assert.equal(missing.configured, false)
  await assert.rejects(missing.start(png, 'image/png'), (e: unknown) => e instanceof PhotoProcessingError && e.statusCode === 503)
  for (const fetcher of [
    async () => new Response('private provider trace', { status: 401 }),
    async () => { throw new TypeError('connection refused') },
    async () => Response.json({ status: 'COMPLETED', output: { image_base64: 'broken' } }),
  ]) {
    const adapter = new RunpodBiRefNet('test', 'secret', async (url, options) => String(url).endsWith('/run') ? Response.json({ id: job.id }) : fetcher(url, options))
    await adapter.start(png, 'image/png')
    await assert.rejects(adapter.status(job.id), (e: unknown) => e instanceof PhotoProcessingError && e.statusCode === 502 && !e.message.includes('private'))
    await assert.rejects(adapter.status('unowned-id'), (e: unknown) => e instanceof PhotoProcessingError && e.statusCode === 404)
  }
  assert.throws(() => new RunpodBiRefNet('../invalid', 'secret'))
})
