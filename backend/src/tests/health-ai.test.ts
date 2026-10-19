import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { HealthStore } from '../health/store.js'
import { HealthService } from '../health/service.js'
import { RunpodHealthAssistant, healthAssistantFromEnvironment, progressFacts } from '../health/ai.js'
import { HealthRunpodCompletion, type CompletionInput, type HealthCompletion } from '../health/runpod.js'
import { createApp } from '../app.js'

const date = '2026-10-19'
const base = { message: 'Проверьте черновик', questions: [], warnings: [] }
const strength = { exerciseId: 'bench-press', name: 'Жим лёжа', kind: 'strength', bodyweight: false, sets: [{ reps: 10, weight: null }], minutes: null, distanceKm: null }
const workout = { ...base, workout: { name: 'Тренировка', location: 'gym', entries: [strength] } }
const input = { text: 'Жим 1×10, вес не указан', date }
const output = (text: string) => ({ text, model: 'test-vl', promptTokens: 50, completionTokens: 20, executionMs: 100, delayMs: 10 })
const completion = (value: unknown, inspect?: (input: CompletionInput) => void): HealthCompletion => ({ model: 'test-vl', async complete(input) { inspect?.(input); return output(JSON.stringify(value)) } })
const service = (value: unknown, inspect?: (input: CompletionInput) => void, limit = 100) => new HealthService(new HealthStore(), new RunpodHealthAssistant(completion(value, inspect)), limit)
const signal = () => new AbortController().signal
const png = async () => `data:image/png;base64,${(await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')}`

void test('AI validates inputs before submission and never writes workout drafts', async () => {
  let requests = 0
  const s = service(workout, () => requests++)
  try {
    const before = s.store.state('default')
    await assert.rejects(s.assist('default', 'parse-workout', { ...input, date: '2026-02-30' }, signal()))
    await assert.rejects(s.assist('default', 'parse-workout', { ...input, text: '' }, signal()))
    assert.equal(requests, 0)
    const reply = await s.assist('default', 'parse-workout', input, signal())
    assert.equal(reply.status, 'completed')
    if (reply.status === 'completed' && reply.operation === 'parse-workout') assert.equal(reply.workout.entries[0].sets[0].weight, null)
    assert.deepEqual(s.store.state('default'), before)
    assert.equal(s.store.aiUsage(), 1)
  } finally { s.close() }
})
void test('food photo bytes are checked and normalized; catalog and history stay isolated', async () => {
  const response = { ...base, food: { name: 'Еда', components: [{ name: 'Рис', productId: 'other-product', estimatedGrams: 150 }], label: { name: 'Выдумка', brand: '', per100: { calories: 100, protein: 1, fat: 2, carbs: 3 } } } }
  let sent: CompletionInput | undefined
  const s = service(response, value => { sent = value })
  try {
    await s.save('other', 'products', { name: 'Секрет другого профиля', per100: { calories: 100, protein: 1, fat: 2, carbs: 3 } })
    const before = s.store.state('default')
    await assert.rejects(s.assist('default', 'recognize-food', { text: '', photo: 'https://example.com/secret', mode: 'dish', date }, signal()))
    assert.equal(s.store.aiUsage(), 0)
    const reply = await s.assist('default', 'recognize-food', { text: 'Рис', photo: await png(), mode: 'dish', date }, signal())
    assert.ok(sent?.image?.startsWith('data:image/webp;base64,'))
    assert.ok(!sent?.text.includes('Секрет'))
    if (reply.status !== 'completed' || reply.operation !== 'recognize-food') assert.fail('food response')
    assert.equal(reply.food.label, null)
    assert.equal(reply.food.components[0].productId, null)
    assert.deepEqual(s.store.state('default'), before)
  } finally { s.close() }
})
void test('label mode exposes only a checked structural draft and rejects invented nutrition properties', async () => {
  const label = { name: 'Молоко', brand: 'Тест', per100: { calories: 50, protein: 3, fat: 2, carbs: 5 } }
  const s = service({ ...base, food: { name: 'Молоко', components: [], label } })
  try {
    const reply = await s.assist('default', 'recognize-food', { text: '', photo: await png(), mode: 'label', date }, signal())
    if (reply.status !== 'completed' || reply.operation !== 'recognize-food') assert.fail('food response')
    assert.deepEqual(reply.food.label, label)
    assert.equal(s.store.list('default', 'products').length, 0)
  } finally { s.close() }
  const invalid = service({ ...base, food: { name: 'Еда', components: [], label, calories: 555 } })
  try { await assert.rejects(invalid.assist('default', 'recognize-food', { text: '', photo: await png(), mode: 'dish', date }, signal()), /проверку/) } finally { invalid.close() }
})
void test('recommendations are limited to catalog and never assign working weights', async () => {
  const body = { text: 'Тренировка', date, location: 'gym', minutes: 30, equipment: 'Штанга', experience: 'beginner' }
  const s = service({ ...workout, workout: { ...workout.workout, entries: [{ ...strength, sets: [{ reps: 10, weight: 90 }] }] } })
  try {
    const reply = await s.assist('default', 'suggest-workout', body, signal())
    if (reply.status !== 'completed' || reply.operation !== 'suggest-workout') assert.fail('workout response')
    assert.equal(reply.workout.entries[0].sets[0].weight, null)
  } finally { s.close() }
  const bad = service({ ...workout, workout: { ...workout.workout, entries: [{ ...strength, exerciseId: 'invented' }] } })
  try { await assert.rejects(bad.assist('default', 'suggest-workout', body, signal()), /проверку/) } finally { bad.close() }
})
void test('recommendations take exercise metadata from the catalog instead of model guesses', async () => {
  const s = service({ ...workout, workout: { ...workout.workout, entries: [{ ...strength, exerciseId: 'walking', name: 'Неверное название', kind: 'strength', bodyweight: true, minutes: 15, distanceKm: null, sets: [{ reps: 10, weight: 90 }] }] } })
  try {
    const reply = await s.assist('default', 'suggest-workout', { text: 'Ходьба без оборудования', date, location: 'home', minutes: 20, equipment: 'Без оборудования', experience: 'beginner' }, signal())
    if (reply.status !== 'completed' || reply.operation !== 'suggest-workout') assert.fail('workout response')
    assert.deepEqual(reply.workout.entries[0], { exerciseId: 'walking', name: 'Ходьба', kind: 'cardio', bodyweight: false, sets: [], minutes: 15, distanceKm: null })
    assert.equal(s.store.list('default', 'workouts').length, 0)
  } finally { s.close() }
})
void test('photo recognition does not relay unsupported edibility claims from model prose', async () => {
  const label = { name: 'Graphite Test Bar', brand: '', per100: { calories: 250, protein: 12, fat: 8, carbs: 30 } }
  const s = service({ message: 'Продукт несъедобен', questions: ['Вы уверены, что это еда?'], warnings: ['Это графит, не предназначенный для еды'], food: { name: label.name, components: [], label } })
  try {
    const reply = await s.assist('default', 'recognize-food', { text: '', photo: await png(), mode: 'label', date }, signal())
    if (reply.status !== 'completed' || reply.operation !== 'recognize-food') assert.fail('food response')
    assert.deepEqual(reply.food.label, label)
    assert.doesNotMatch([reply.message, ...reply.questions, ...reply.warnings].join(' '), /несъедоб|графит|уверены/i)
    assert.match(reply.message, /Сверьте/)
    assert.equal(s.store.list('default', 'products').length, 0)
  } finally { s.close() }
})
void test('workout review questions reflect missing fields, not invented catalog warnings', async () => {
  const s = service({ ...workout, message: 'Всё сохранено', questions: ['Укажите вес тела'], warnings: ['Жим не найден в каталоге'], workout: { ...workout.workout, entries: [{ ...strength, sets: [{ reps: 10, weight: 40 }] }] } })
  try {
    const reply = await s.assist('default', 'parse-workout', input, signal())
    if (reply.status !== 'completed' || reply.operation !== 'parse-workout') assert.fail('workout response')
    assert.deepEqual(reply.questions, [])
    assert.deepEqual(reply.warnings, [])
    assert.match(reply.message, /черновик/)
    assert.equal(s.store.list('default', 'workouts').length, 0)
  } finally { s.close() }
  const missing = service(workout)
  try {
    const reply = await missing.assist('default', 'parse-workout', input, signal())
    if (reply.status !== 'completed') assert.fail('completed response')
    assert.equal(reply.questions.length, 1)
    assert.match(reply.questions[0], /вес/)
  } finally { missing.close() }
})
void test('progress uses computed data, omits private notes, and rejects unsupported references', async () => {
  let sent = ''
  const s = service({ ...base, observations: [{ factId: 'nutrition-days', text: 'Записей недостаточно.' }] }, input => { sent = input.text })
  try {
    await s.save('default', 'wellbeing', { date, score: 4, note: 'Личная заметка' })
    const facts = progressFacts(s.store.state('default'), { operation: 'explain-progress', to: date, days: 7 })
    assert.equal(facts.find(fact => fact.id === 'calories')?.value, null)
    const reply = await s.assist('default', 'explain-progress', { to: date, days: 7 }, signal())
    assert.equal(reply.status, 'completed')
    assert.ok(!sent.includes('Личная заметка'))
  } finally { s.close() }
  const invalid = service({ ...base, observations: [{ factId: 'invented', text: 'Неизвестно' }] })
  try { await assert.rejects(invalid.assist('default', 'explain-progress', { to: date, days: 30 }, signal()), /проверку/) } finally { invalid.close() }
})
void test('quota persists on reopen and cannot be bypassed with another profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sport-ai-')), path = join(dir, 'health.sqlite')
  let s = new HealthService(new HealthStore(path), new RunpodHealthAssistant(completion(workout)), 1)
  try {
    await s.assist('default', 'parse-workout', input, signal())
    s.close(); s = new HealthService(new HealthStore(path), new RunpodHealthAssistant(completion(workout)), 1)
    await assert.rejects(s.assist('other', 'parse-workout', input, signal()), /лимит/)
    assert.equal(s.capabilities().monthlyRequests.used, 1)
    s.store.reserveAiRequest(1, '2027-01')
    assert.equal(s.store.aiUsage('2027-01'), 1)
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }) }
})
void test('v1 diary migrates without changing records or photo attachments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sport-ai-migration-')), path = join(dir, 'health.sqlite')
  const previous = new DatabaseSync(path)
  previous.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, settings TEXT);
    CREATE TABLE records (profile TEXT NOT NULL REFERENCES profiles(id), kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile,kind,id));
    CREATE TABLE photos (profile TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'meals' CHECK(kind='meals'), id TEXT NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY(profile,id), FOREIGN KEY(profile,kind,id) REFERENCES records(profile,kind,id) ON DELETE CASCADE);
    INSERT INTO profiles VALUES('default',NULL);
    PRAGMA user_version=1;
  `)
  const meal = { id: 'old-meal', name: 'История', date, kind: 'lunch', note: 'Сохранить', items: [], hasPhoto: true, photoVersion: 'v1' }
  previous.prepare('INSERT INTO records VALUES(?,?,?,?)').run('default', 'meals', meal.id, JSON.stringify(meal))
  previous.prepare('INSERT INTO photos(profile,id,data) VALUES(?,?,?)').run('default', meal.id, Buffer.from('photo bytes'))
  previous.close()
  const store = new HealthStore(path)
  try {
    assert.deepEqual(store.require('default', 'meals', meal.id), meal)
    assert.equal(Buffer.from(store.photo('default', meal.id)!).toString(), 'photo bytes')
    assert.equal(store.aiUsage(), 0)
    store.reserveAiRequest(1)
    assert.equal(store.aiUsage(), 1)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
void test('concurrent submissions are rejected and failed provider calls consume their reservation', async () => {
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const provider: HealthCompletion = { model: 'test', async complete(_input, active) { started(); return new Promise((_resolve, reject) => active.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } }
  const s = new HealthService(new HealthStore(), new RunpodHealthAssistant(provider))
  const controller = new AbortController()
  try {
    const pending = s.assist('default', 'parse-workout', input, controller.signal)
    await startedPromise
    await assert.rejects(s.assist('other', 'parse-workout', input, signal()), /Уже выполняется/)
    controller.abort(); await assert.rejects(pending, /cancelled/)
    assert.equal(s.store.aiUsage(), 1)
  } finally { s.close() }
})

const envelope = (text = JSON.stringify(workout), finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } })
const request = { system: 'test', text: 'data', image: 'data:image/webp;base64,dGVzdA==', schema: { type: 'object' } }
void test('Runpod sends multimodal structured input exactly once and unwraps queued completion', async () => {
  const paths: string[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url).split('/').slice(-2).join('/'); paths.push(path)
    if (String(url).endsWith('/run')) {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.input.openai_route, '/v1/chat/completions')
      assert.equal(body.input.openai_input.messages[1].content[1].image_url.url, request.image)
      assert.equal(body.input.openai_input.response_format.type, 'json_schema')
      assert.equal(body.policy.executionTimeout, 90000)
      return Response.json({ id: 'job-1', status: 'IN_QUEUE' })
    }
    return Response.json({ id: 'job-1', status: 'COMPLETED', output: [envelope()], executionTime: 50, delayTime: 100 })
  }
  const reply = await new HealthRunpodCompletion('test', 'secret', 'test-vl', fetcher, 1).complete(request, signal())
  assert.equal(reply.executionMs, 50)
  assert.deepEqual(paths, ['test/run', 'status/job-1'])
})
void test('Runpod abort during submit still cancels the received job without resubmission', async () => {
  const controller = new AbortController(), paths: string[] = []
  const fetcher: typeof fetch = async url => {
    paths.push(String(url))
    if (String(url).endsWith('/run')) { controller.abort(); return Response.json({ id: 'job-1', status: 'IN_QUEUE' }) }
    return Response.json({ status: 'CANCELLED' })
  }
  await assert.rejects(new HealthRunpodCompletion('test', 'secret', 'test', fetcher, 1).complete(request, controller.signal), /отменён/)
  assert.equal(paths.length, 2)
  assert.ok(paths[1].endsWith('/cancel/job-1'))
})
void test('Runpod rejects truncated/malformed responses, timeouts and upstream errors safely', async () => {
  for (const output of [envelope('{}', 'length'), { error: 'secret prompt' }, []]) {
    const fetcher: typeof fetch = async () => Response.json({ id: 'job', status: 'COMPLETED', output })
    await assert.rejects(new HealthRunpodCompletion('test', 'secret', 'test', fetcher).complete(request, signal()), error => error instanceof Error && !error.message.includes('secret'))
  }
  let calls = 0, cancelled = false
  const queued: typeof fetch = async url => { calls++; if (String(url).includes('/cancel/')) cancelled = true; return Response.json({ id: 'job', status: 'IN_QUEUE' }) }
  await assert.rejects(new HealthRunpodCompletion('test', 'secret', 'test', queued, 1, 10).complete(request, signal()), /истекло/)
  assert.ok(calls > 1 && cancelled)
  const denied: typeof fetch = async () => new Response('secret', { status: 401 })
  await assert.rejects(new HealthRunpodCompletion('test', 'secret', 'test', denied).complete(request, signal()), /Ключ Runpod/)
})
void test('assistant HTTP contract exposes capabilities and accepts validated drafts only', async () => {
  const s = service(workout), app = createApp(undefined, { health: s })
  try {
    assert.equal((await app.inject('/api/sport/capabilities')).json().provider, 'runpod')
    const reply = await app.inject({ method: 'POST', url: '/api/sport/assistant/parse-workout', payload: input })
    assert.equal(reply.statusCode, 200)
    assert.equal(reply.json().status, 'completed')
    assert.equal((await app.inject({ method: 'POST', url: '/api/sport/assistant/parse-workout', payload: {} })).statusCode, 400)
    assert.equal(s.store.list('default', 'workouts').length, 0)
  } finally { await app.close() }
})
void test('health environment never falls back to other modules or providers', () => {
  const previous = process.env.HEALTH_RUNPOD_ENDPOINT_ID
  delete process.env.HEALTH_RUNPOD_ENDPOINT_ID
  try { assert.equal(healthAssistantFromEnvironment().configured, false) }
  finally { if (previous !== undefined) process.env.HEALTH_RUNPOD_ENDPOINT_ID = previous }
})
