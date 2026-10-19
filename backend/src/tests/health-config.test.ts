import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { healthAiConfiguration } from '../health/config.js'
import { HealthService } from '../health/service.js'
import { HealthStore } from '../health/store.js'

const input = { date: '2026-10-19', text: 'Ходьба 20 минут' }
const response = { message: '', questions: [], warnings: [], workout: { name: 'Ходьба', location: 'home', entries: [{ exerciseId: 'walking', name: 'Ходьба', kind: 'cardio', bodyweight: false, sets: [], minutes: 20, distanceKm: null }] } }

void test('health AI configuration validates quota without leaking values or making requests', async () => {
  let requests = 0
  const fetcher: typeof fetch = async () => { requests++; throw new Error('Unexpected network') }
  for (const raw of [undefined, '', '  ', '0', '100', '10000']) {
    const config = healthAiConfiguration({ HEALTH_AI_MONTHLY_REQUEST_LIMIT: raw }, fetcher)
    assert.equal(config.monthlyLimit, raw?.trim() ? Number(raw) : 100)
    assert.equal(config.warning, null)
  }
  for (const patch of [
    { HEALTH_AI_MONTHLY_REQUEST_LIMIT: 'secret-invalid-limit' },
    { HEALTH_AI_MONTHLY_REQUEST_LIMIT: '-1' },
    { HEALTH_AI_MONTHLY_REQUEST_LIMIT: '1.5' },
    { HEALTH_AI_MONTHLY_REQUEST_LIMIT: '10001' },
    { HEALTH_AI_MONTHLY_REQUEST_LIMIT: 'Infinity' },
    { HEALTH_RUNPOD_ENDPOINT_ID: 'https://invalid-secret-endpoint' },
    { RUNPOD_API_KEY: '', HEALTH_RUNPOD_API_KEY: '' },
  ]) {
    const config = healthAiConfiguration({ HEALTH_RUNPOD_ENDPOINT_ID: 'test-endpoint', RUNPOD_API_KEY: 'secret-shared-key', ...patch }, fetcher)
    assert.equal(config.assistant.configured, false)
    assert.equal(config.assistant.unavailable?.code, 'invalid-configuration')
    if ('HEALTH_AI_MONTHLY_REQUEST_LIMIT' in patch) assert.equal(config.monthlyLimit, 0)
    const service = new HealthService(new HealthStore(), config.assistant, config.monthlyLimit)
    try {
      const reply = await service.assist('default', 'parse-workout', input, new AbortController().signal)
      assert.equal(reply.message, service.capabilities().aiUnavailable?.message)
      assert.equal(service.store.aiUsage(), 0)
      assert.doesNotMatch(JSON.stringify([config.warning, reply, service.capabilities()]), /secret-/)
    } finally { service.close() }
  }
  assert.equal(requests, 0)
})

void test('dedicated key wins; blank key is compatible; rejected key never retries with shared key', async () => {
  for (const dedicated of [' sport-key ', '', '  ', undefined]) {
    const headers: string[] = []
    const fetcher: typeof fetch = async (_url, init) => {
      headers.push(new Headers(init?.headers).get('Authorization')!)
      return Response.json({ id: 'job', status: 'COMPLETED', output: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] } })
    }
    const env = { HEALTH_RUNPOD_ENDPOINT_ID: 'sport', HEALTH_RUNPOD_API_KEY: dedicated, RUNPOD_API_KEY: 'shared-key' }
    const config = healthAiConfiguration(env, fetcher)
    // Credential choice is a snapshot, not a re-read on every request.
    env.RUNPOD_API_KEY = 'changed'; env.HEALTH_RUNPOD_API_KEY = 'changed'
    const s = new HealthService(new HealthStore(), config.assistant, config.monthlyLimit)
    try {
      assert.equal((await s.assist('default', 'parse-workout', input, new AbortController().signal)).status, 'completed')
      assert.deepEqual(headers, [`Bearer ${dedicated?.trim() || 'shared-key'}`])
      assert.equal(s.capabilities().aiUnavailable, null)
    } finally { s.close() }
  }
  for (const status of [401, 403]) {
    const headers: string[] = []
    const config = healthAiConfiguration({ HEALTH_RUNPOD_ENDPOINT_ID: 'sport', HEALTH_RUNPOD_API_KEY: 'sport-key', RUNPOD_API_KEY: 'shared-key' }, async (_url, init) => {
      headers.push(new Headers(init?.headers).get('Authorization')!)
      return new Response('provider-secret', { status })
    })
    const s = new HealthService(new HealthStore(), config.assistant, config.monthlyLimit)
    try {
      await assert.rejects(s.assist('default', 'parse-workout', input, new AbortController().signal), /Ключ Runpod/)
      assert.deepEqual(headers, ['Bearer sport-key'])
      assert.equal(s.store.aiUsage(), 1)
    } finally { s.close() }
  }
})

void test('zero configured quota blocks model submission', async () => {
  let requests = 0
  const config = healthAiConfiguration({ HEALTH_RUNPOD_ENDPOINT_ID: 'sport', HEALTH_RUNPOD_API_KEY: 'test', HEALTH_AI_MONTHLY_REQUEST_LIMIT: '0' }, async () => { requests++; throw new Error('Unexpected network') })
  const s = new HealthService(new HealthStore(), config.assistant, config.monthlyLimit)
  try {
    await assert.rejects(s.assist('default', 'parse-workout', input, new AbortController().signal), /лимит/)
    assert.equal(requests, 0)
    assert.equal(s.store.aiUsage(), 0)
  } finally { s.close() }
})

void test('real server starts with absent/invalid optional AI settings and serves all modules', { timeout: 60000 }, async t => {
  for (const [name, patch] of [
    ['no endpoint', {}],
    ['missing key', { HEALTH_RUNPOD_ENDPOINT_ID: 'test' }],
    ['invalid endpoint', { HEALTH_RUNPOD_ENDPOINT_ID: 'invalid/private-value', HEALTH_RUNPOD_API_KEY: 'private-key' }],
    ['invalid quota', { HEALTH_AI_MONTHLY_REQUEST_LIMIT: 'private-limit' }],
  ] as const) await t.test(name, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-startup-'))
    const portServer = createServer()
    portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening')
    const port = (portServer.address() as { port: number }).port
    await new Promise<void>(resolve => portServer.close(() => resolve()))
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../server.ts', import.meta.url))], {
      cwd: directory,
      env: { PATH: process.env.PATH, PORT: String(port), PLANNING_LLM: 'off', TREND_MEMORY_PATH: join(directory, 'trends.sqlite'), PLANNING_DB_PATH: join(directory, 'planning.sqlite'), PLANNING_KEY_PATH: join(directory, 'planning.key'), HEALTH_DB_PATH: join(directory, 'health.sqlite'), ...patch },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += String(value) })
    child.stderr.on('data', value => { stderr += String(value) })
    const exited = once(child, 'exit')
    try {
      const deadline = Date.now() + 10000
      while (!stdout.includes('Trend research API:') && child.exitCode === null && Date.now() < deadline) await pause(20)
      assert.match(stdout, /Trend research API:/, `Startup failed: ${stderr}`)
      const root = `http://127.0.0.1:${port}`
      for (const path of ['/api/health', '/api/trends/capabilities', '/api/wardrobe/agent/capabilities', '/api/planning/capabilities', '/api/sport/state']) assert.equal((await fetch(root + path)).status, 200, path)
      const caps = await (await fetch(root + '/api/sport/capabilities')).json()
      assert.equal(caps.ai, false)
      assert.equal(caps.aiUnavailable.code, name === 'no endpoint' ? 'not-configured' : 'invalid-configuration')
      const product = await fetch(root + '/api/sport/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Тест', per100: { calories: 100, protein: 1, fat: 2, carbs: 3 } }) })
      assert.equal(product.status, 201)
      const id = (await product.json()).id
      assert.equal((await fetch(root + `/api/sport/products/${id}`)).status, 200)
      assert.equal((await fetch(root + `/api/sport/products/${id}`, { method: 'DELETE' })).status, 200)
      const reply = await (await fetch(root + '/api/sport/assistant/parse-workout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json()
      assert.equal(reply.status, 'unavailable')
      assert.equal(reply.message, caps.aiUnavailable.message)
      assert.equal(caps.monthlyRequests.used, 0)
      assert.equal(stderr.split('\n').filter(line => line.includes('Спортивный AI отключён.')).length, name === 'no endpoint' ? 0 : 1)
      assert.doesNotMatch(stdout + stderr, /private-/)
    } finally {
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited; clearTimeout(killTimer)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
