import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createApp } from '../app.js'
import { HealthStore } from '../health/store.js'
import { HealthService } from '../health/service.js'
import { prepareMealPhoto } from '../health/photos.js'
import { daySummary, healthStats, adjustSets, mealNutrition, todayInZone, shiftDate } from '../../../shared/health-math.mjs'
import type { Product, Workout, WorkoutTemplate, Meal, HealthSettings } from '../../../shared/health.js'

const date = '2026-10-19'
const food = { name: 'Йогурт', brand: 'Тест', per100: { calories: 70, protein: 5, fat: 2, carbs: 8 } }
const settings: HealthSettings = { timeZone: 'Europe/Moscow', goals: { calories: 2000, protein: null, fat: null, carbs: null } }
const setup = () => new HealthService(new HealthStore())
const product = async (s: HealthService) => await s.save('default', 'products', food) as Product
const workout = async (s: HealthService) => await s.save('default', 'workouts', { name: 'Силовая', date, location: 'gym', note: '', entries: [{ id: 'row', exerciseId: 'bench-press', sets: [{ reps: 10, weight: 20 }, { reps: 8, weight: 30 }], minutes: null, distanceKm: null }] }) as Workout
const meal = async (s: HealthService, p: Product, extra = {}) => await s.save('default', 'meals', { date, name: 'Завтрак', kind: 'breakfast', note: '', items: [{ id: 'item', productId: p.id, grams: 150 }], ...extra }) as Meal
const photoData = async (width = 20) => `data:image/png;base64,${(await sharp({ create: { width, height: 10, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')}`

void test('state seeds each profile once; catalog deletions do not reappear', () => {
  const s = setup()
  try {
    assert.equal(s.store.state('default').settings, null)
    assert.equal(s.store.state('default').exercises.length, 8)
    s.store.remove('default', 'exercises', 'running')
    assert.equal(s.store.state('default').exercises.length, 7)
    assert.equal(s.store.state('other').exercises.length, 8)
  } finally { s.close() }
})
void test('nutrition uses entered calories and retains snapshots after catalog edits/deletion', async () => {
  const s = setup()
  try {
    const p = await product(s), m = await meal(s, p)
    assert.deepEqual(mealNutrition(m), { calories: 105, protein: 7.5, fat: 3, carbs: 12 })
    await s.save('default', 'products', { ...food, name: 'Изменённый', per100: { ...food.per100, calories: 999 } }, p.id)
    s.store.remove('default', 'products', p.id)
    const edited = await s.save('default', 'meals', { ...m, items: [{ id: 'item', productId: p.id, grams: 200 }] }, m.id) as Meal
    assert.equal(mealNutrition(edited).calories, 140)
    assert.equal(edited.items[0].product.name, 'Йогурт')
    assert.equal(daySummary(s.store.state('default'), date).nutrition.calories, 140)
    await assert.rejects(s.save('other', 'meals', m), /не найдена/)
  } finally { s.close() }
})
void test('workout snapshots, template copies and mass changes are independent', async () => {
  const s = setup()
  try {
    const w = await workout(s)
    await s.save('default', 'exercises', { name: 'Другой жим', kind: 'cardio', bodyweight: false }, 'bench-press')
    const template = await s.save('default', 'templates', { ...w, source: { kind: 'workouts', id: w.id } }) as WorkoutTemplate
    assert.equal(template.entries[0].exercise.name, 'Жим лёжа')
    const copy = await s.save('default', 'workouts', { ...template, date, entries: adjustSets(template.entries, 'weight', 5), source: { kind: 'templates', id: template.id } }) as Workout
    assert.notEqual(copy.id, w.id)
    assert.equal(copy.entries[0].sets[0].weight, 25)
    assert.equal(s.store.require<Workout>('default', 'workouts', w.id).entries[0].sets[0].weight, 20)
    assert.equal(s.store.require<WorkoutTemplate>('default', 'templates', template.id).entries[0].sets[0].weight, 20)
    assert.equal(adjustSets(w.entries, 'weight', -100)[0].sets[0].weight, 0)
    assert.equal(adjustSets(w.entries, 'reps', -100)[0].sets[0].reps, 1)
    const stats = healthStats(s.store.state('default'), date, 7, 'bench-press')
    assert.equal(stats.exercisePoints[0].volume, 970)
    assert.equal(stats.exercisePoints[0].maxWeight, 35)
  } finally { s.close() }
})
void test('cardio pace excludes unknown distances; bodyweight never invents tonnage', async () => {
  const s = setup()
  try {
    await s.save('default', 'workouts', { name: 'Кардио', date, location: 'outdoors', entries: [
      { id: 'a', exerciseId: 'running', sets: [], minutes: 30, distanceKm: 5 },
      { id: 'b', exerciseId: 'running', sets: [], minutes: 20, distanceKm: null },
      { id: 'c', exerciseId: 'push-ups', sets: [{ reps: 15, weight: 0 }], minutes: null, distanceKm: null },
    ] })
    const state = s.store.state('default'), running = healthStats(state, date, 7, 'running')
    assert.equal(running.cardioMinutes, 50)
    assert.equal(running.exercisePoints[0].pace, 6)
    assert.equal(running.exercisePoints[0].distanceKm, 5)
    const pushups = healthStats(state, date, 7, 'push-ups').exercisePoints[0]
    assert.equal(pushups.volume, null)
    assert.equal(pushups.reps, 15)
    assert.equal(pushups.maxWeight, null)
    assert.equal(running.days[0].nutrition, null)
    assert.equal(running.days.length, 7)
  } finally { s.close() }
})
void test('photos validate bytes, dimensions and size; normalized output strips metadata', async () => {
  const info = await sharp(await prepareMealPhoto(await photoData(2000))).metadata()
  assert.equal(info.format, 'webp')
  assert.equal(info.width, 1600)
  assert.equal(info.exif, undefined)
  await assert.rejects(prepareMealPhoto('data:image/png;base64,YmFk'), /прочитать/)
  await assert.rejects(prepareMealPhoto((await photoData()).replace('image/png', 'image/jpeg')), /прочитать/)
  await assert.rejects(prepareMealPhoto(`data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64')}`), /6 МиБ/)
  const giant = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: 'black' } }).png().toBuffer()
  await assert.rejects(prepareMealPhoto(`data:image/png;base64,${giant.toString('base64')}`), /40 Мп/)
})
void test('meal/photo transactions roll back, isolate profiles and cascade deletions', async () => {
  const s = setup()
  try {
    const p = await product(s), m = await meal(s, p, { photo: await photoData() })
    assert.ok(m.hasPhoto)
    assert.ok(s.store.photo('default', m.id)!.length)
    assert.equal(s.store.photo('other', m.id), null)
    const updated = await s.save('default', 'meals', { ...m, name: 'Ужин' }, m.id) as Meal
    assert.equal(updated.photoVersion, m.photoVersion)
    await assert.rejects(s.save('default', 'meals', { ...m, photo: 'data:image/png;base64,YmFk' }, m.id))
    assert.equal(s.store.require<Meal>('default', 'meals', m.id).name, 'Ужин')
    const replaced = await s.save('default', 'meals', { ...updated, photo: await photoData(30) }, m.id) as Meal
    assert.notEqual(replaced.photoVersion, m.photoVersion)
    const savePhoto = s.store.savePhoto.bind(s.store)
    s.store.savePhoto = () => { throw new Error('simulated write failure') }
    await assert.rejects(s.save('default', 'meals', { ...replaced, name: 'Не сохранять', photo: null }, m.id), /write failure/)
    assert.equal(s.store.require<Meal>('default', 'meals', m.id).name, 'Ужин')
    s.store.savePhoto = savePhoto
    const removed = await s.save('default', 'meals', { ...replaced, photo: null }, m.id) as Meal
    assert.equal(removed.hasPhoto, false)
    assert.equal(s.store.photo('default', m.id), null)
    await s.save('default', 'meals', { ...removed, photo: await photoData() }, m.id)
    s.store.remove('default', 'meals', m.id)
    assert.equal(s.store.photo('default', m.id), null)
  } finally { s.close() }
})
void test('SQLite reopens with diary, goals, wellbeing and photos intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-tests-')), path = join(dir, 'health.sqlite')
  let s = new HealthService(new HealthStore(path))
  try {
    const p = await product(s), m = await meal(s, p, { photo: await photoData() })
    s.settings('default', settings)
    await s.save('default', 'wellbeing', { date, score: 4, note: 'Хорошо' })
    s.close(); s = new HealthService(new HealthStore(path))
    const state = s.store.state('default')
    assert.equal(state.meals[0].id, m.id)
    assert.deepEqual(state.settings, settings)
    assert.equal(state.wellbeing[0].score, 4)
    assert.ok(s.store.photo('default', m.id))
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }) }
})
void test('API CRUD, settings, validation, stats and profile boundaries preserve healthcheck', async () => {
  const s = setup(), app = createApp(undefined, { health: s })
  try {
    assert.deepEqual((await app.inject('/api/health')).json(), { status: 'ok' })
    assert.equal((await app.inject('/api/sport/state')).statusCode, 200)
    const created = await app.inject({ method: 'POST', url: '/api/sport/products', payload: food })
    assert.equal(created.statusCode, 201)
    const id = created.json().id as string
    assert.equal((await app.inject(`/api/sport/products/${id}?profileId=other`)).statusCode, 404)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/sport/products/${id}?profileId=other`, payload: food })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/sport/products/${id}?profileId=other` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/sport/products/${id}`, payload: { ...food, name: 'Молоко' } })).json().name, 'Молоко')
    assert.equal((await app.inject({ method: 'PUT', url: '/api/sport/settings', payload: settings })).statusCode, 200)
    assert.deepEqual((await app.inject('/api/sport/settings')).json(), settings)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/sport/settings', payload: { ...settings, timeZone: 'no-such-zone' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/sport/products', payload: { ...food, per100: { ...food.per100, fat: -1 } } })).statusCode, 400)
    for (const invalidDate of ['2026-02-30', '2026-13-01', 'not-a-date']) assert.equal((await app.inject(`/api/sport/summary?date=${invalidDate}`)).statusCode, 400)
    assert.equal((await app.inject(`/api/sport/stats?to=${date}&days=8`)).statusCode, 400)
    assert.equal((await app.inject(`/api/sport/stats?to=${date}&days=90`)).json().days.length, 90)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/sport/products/${id}` })).statusCode, 200)
    assert.equal((await app.inject(`/api/sport/products/${id}`)).statusCode, 404)
    const p = await product(s), m = await meal(s, p, { photo: await photoData() })
    assert.equal((await app.inject(`/api/sport/meals/${m.id}/photo`)).headers['content-type'], 'image/webp')
    assert.equal((await app.inject(`/api/sport/meals/${m.id}/photo?profileId=other`)).statusCode, 404)
    assert.equal((await app.inject(`/api/sport/summary?date=${date}`)).json().nutrition.calories, 105)
    assert.equal((await app.inject({ method: 'POST', url: '/api/sport/wellbeing', payload: { date, score: 6 } })).statusCode, 400)
  } finally { await app.close() }
})
void test('invalid dates, sets, durations and masses never create diary records', async () => {
  const s = setup()
  try {
    const w = await workout(s), valid = { ...w, source: { kind: 'workouts', id: w.id } }
    for (const patch of [{ date: '2026-02-30' }, { entries: [] }, { entries: [{ ...w.entries[0], sets: [{ reps: 0, weight: 20 }] }] }, { entries: [{ ...w.entries[0], minutes: 10 }] }]) await assert.rejects(s.save('default', 'workouts', { ...valid, ...patch }))
    await assert.rejects(s.save('default', 'workouts', { ...valid, entries: [{ id: 'r', exerciseId: 'running', minutes: 0, distanceKm: null, sets: [] }] }))
    const p = await product(s)
    for (const grams of [0, -1, Infinity, NaN]) await assert.rejects(meal(s, p, { items: [{ id: 'x', productId: p.id, grams }] }))
    assert.equal(s.store.list('default', 'workouts').length, 1)
    assert.equal(s.store.list('default', 'meals').length, 0)
  } finally { s.close() }
})
void test('AI stubs never fetch or write even when model environment is configured', async () => {
  const s = setup(), app = createApp(undefined, { health: s })
  const originalFetch = globalThis.fetch, originalKey = process.env.OPENROUTER_API_KEY
  globalThis.fetch = async () => { throw new Error('Network must not be called') }
  process.env.OPENROUTER_API_KEY = 'test-not-a-real-key'
  try {
    const before = s.store.state('default')
    for (const operation of ['parse-workout', 'recognize-food', 'explain-progress', 'suggest-workout'] as const) {
      assert.equal((await s.assistant.run(operation)).status, 'unavailable')
      assert.equal((await app.inject({ method: 'POST', url: `/api/sport/assistant/${operation}`, payload: { text: 'Сделай тренировку', photo: 'test' } })).json().status, 'unavailable')
    }
    assert.deepEqual(s.store.state('default'), before)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey
    await app.close()
  }
})
void test('date labels and today respect midnight, leap days and DST', () => {
  assert.equal(todayInZone('Europe/Moscow', new Date('2026-10-18T22:00:00Z')), date)
  assert.equal(todayInZone('America/New_York', new Date('2026-10-19T01:00:00Z')), '2026-10-18')
  assert.equal(shiftDate('2026-03-29', 1), '2026-03-30')
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29')
})
