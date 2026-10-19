import test from 'node:test'
import assert from 'node:assert/strict'
import type { Exercise, HealthAiInput, HealthAiWorkout, Product, Workout } from '../../../shared/health.js'
import { normalizeAiWorkoutEntry } from '../../../shared/health-ai-workout.mjs'
import { HealthStore } from '../health/store.js'
import { HealthService } from '../health/service.js'
import { RunpodHealthAssistant } from '../health/ai.js'
import { progressExplanation, selectProgressInsights } from '../health/progress.js'

const date = '2026-10-19'
const input: Extract<HealthAiInput, { operation: 'explain-progress' }> = { operation: 'explain-progress', to: date, days: 7 }
const entry: HealthAiWorkout['entries'][number] = { exerciseId: 'walking', name: 'Ошибочное имя', kind: 'strength', bodyweight: true, sets: [{ reps: 10, weight: null }], minutes: 20, distanceKm: null }
function setup(reply: unknown, inspect?: (text: string) => void) {
  return new HealthService(new HealthStore(), new RunpodHealthAssistant({ model: 'fixture', async complete(request) {
    inspect?.(request.text)
    return { text: JSON.stringify(reply), model: 'fixture', promptTokens: 1, completionTokens: 1, executionMs: 1, delayMs: 0 }
  } }))
}
const workoutReply = (entries: HealthAiWorkout['entries']) => ({ message: '', questions: [], warnings: [], workout: { name: 'Тест', location: 'home', entries } })

void test('parse-workout canonicalizes known metadata, preserves unknown numbers, and saves only explicitly', async () => {
  const s = setup(workoutReply([
    entry,
    { ...entry, exerciseId: 'bench-press', kind: 'cardio', sets: [{ reps: null, weight: null }] },
    { ...entry, exerciseId: 'unknown', name: 'Новое кардио', kind: 'cardio', minutes: null },
  ]))
  try {
    const before = s.store.state('default')
    const reply = await s.assist('default', 'parse-workout', { text: 'Ходьба и жим', date }, new AbortController().signal)
    if (reply.status !== 'completed' || reply.operation !== 'parse-workout') assert.fail('workout reply')
    assert.deepEqual(reply.workout.entries[0], { ...entry, exerciseId: 'walking', name: 'Ходьба', kind: 'cardio', bodyweight: false, sets: [] })
    assert.deepEqual(reply.workout.entries[1], { ...entry, exerciseId: 'bench-press', name: 'Жим лёжа', kind: 'strength', bodyweight: false, sets: [{ reps: null, weight: null }], minutes: null, distanceKm: null })
    assert.equal(reply.workout.entries[2].exerciseId, null)
    assert.equal(reply.workout.entries[2].bodyweight, false)
    assert.equal(reply.workout.entries[2].minutes, null)
    assert.deepEqual(s.store.state('default'), before)
    assert.doesNotMatch(reply.questions.join(' '), /Уточните упражнение «Ходьба»/)
    const saved = await s.save('default', 'workouts', { name: 'Ходьба', date, location: 'home', entries: [{ ...reply.workout.entries[0], id: 'row' }] }) as Workout
    assert.equal(saved.entries[0].minutes, 20)
    assert.equal(saved.entries[0].exercise.bodyweight, false)
    const created = await s.save('default', 'exercises', reply.workout.entries[2]) as Exercise
    assert.equal(created.kind, 'cardio')
    assert.equal(created.bodyweight, false)
  } finally { s.close() }
})

void test('review can select a different catalog kind or correct an unknown kind without converting measurements', () => {
  const original = structuredClone(entry)
  const unknown = normalizeAiWorkoutEntry({ ...entry, exerciseId: null, minutes: null })
  const cardio = normalizeAiWorkoutEntry(unknown, { id: 'walking', name: 'Ходьба', kind: 'cardio', bodyweight: false })
  assert.deepEqual(cardio.sets, [])
  assert.equal(cardio.minutes, null, '10 repetitions must not become 10 minutes')
  const custom = normalizeAiWorkoutEntry({ ...cardio, kind: 'strength', bodyweight: true })
  assert.equal(custom.exerciseId, null)
  assert.equal(custom.minutes, null)
  assert.deepEqual(custom.sets, [], 'changing kind must not invent sets')
  const corrected = normalizeAiWorkoutEntry({ ...custom, kind: 'cardio' })
  assert.equal(corrected.bodyweight, false)
  assert.deepEqual(entry, original)
})

void test('empty period accepts only the no-data insight and cannot display model prose', async () => {
  const s = setup({ insightIds: ['no-data'] }, text => {
    const data = JSON.parse(text)
    assert.deepEqual(data.insights.map((item: { id: string }) => item.id), ['no-data'])
  })
  try {
    const before = s.store.state('default')
    const reply = await s.assist('default', 'explain-progress', input, new AbortController().signal)
    if (reply.status !== 'completed' || reply.operation !== 'explain-progress') assert.fail('progress reply')
    assert.equal(reply.facts.find(fact => fact.id === 'workouts')?.value, 0)
    assert.equal(reply.facts.find(fact => fact.id === 'calories')?.value, null)
    assert.match(reply.observations[0].text, /нет записей/)
    assert.doesNotMatch(reply.message, /не тренировались|не ели/)
    assert.deepEqual(s.store.state('default'), before)
  } finally { s.close() }
  for (const bad of [
    { insightIds: [] }, { insightIds: ['invented'] }, { insightIds: ['no-data', 'no-data'] },
    { insightIds: Array.from({ length: 13 }, (_, i) => `fact-${i}`) },
    { observations: [{ factId: 'workouts', text: 'Вы провели 100 тренировок.' }] },
    ...['message', 'questions', 'warnings', 'observations'].map(key => ({ insightIds: ['no-data'], [key]: key === 'message' ? 'Вы провели 100 тренировок.' : ['Вы провели 100 тренировок.'] })),
  ]) {
    const invalid = setup(bad)
    try {
      const before = invalid.store.state('default')
      await assert.rejects(invalid.assist('default', 'explain-progress', input, new AbortController().signal), /проверку/)
      assert.equal(invalid.store.aiUsage(), 1, 'one attempt, no retry')
      assert.deepEqual(invalid.store.state('default'), before)
    } finally { invalid.close() }
  }
})

void test('populated explanations use historical nutrition, recorded days and safe exercise metrics', async () => {
  const s = setup({ insightIds: ['calories', 'workouts', 'nutrition-days'] })
  try {
    const product = await s.save('default', 'products', { name: 'Йогурт', per100: { calories: 70, protein: 5, fat: 2, carbs: 8 } }) as Product
    await s.save('default', 'meals', { name: 'Завтрак', date, kind: 'breakfast', items: [{ id: 'item', productId: product.id, grams: 150 }] })
    await s.save('default', 'products', { ...product, per100: { ...product.per100, calories: 999 } }, product.id)
    await s.save('default', 'workouts', { name: 'Кардио и отжимания', date, location: 'home', entries: [
      { id: 'a', exerciseId: 'walking', sets: [], minutes: 20, distanceKm: null },
      { id: 'b', exerciseId: 'push-ups', sets: [{ reps: 10, weight: 0 }], minutes: null, distanceKm: null },
    ] })
    await s.save('default', 'wellbeing', { date, score: 4, note: 'Не передавать личную заметку' })
    const before = s.store.state('default')
    const explanation = progressExplanation(before, input)
    const reply = await s.assist('default', 'explain-progress', input, new AbortController().signal)
    if (reply.status !== 'completed' || reply.operation !== 'explain-progress') assert.fail('progress reply')
    assert.equal(reply.facts.find(fact => fact.id === 'calories')?.value, 105)
    assert.deepEqual(reply.observations, selectProgressInsights(explanation, { insightIds: ['calories', 'workouts', 'nutrition-days'] }).observations)
    assert.match(reply.observations[0].text, /105 ккал/)
    assert.match(reply.observations[1].text, /тренировок: 1/)
    assert.match(reply.warnings.join(' '), /не за каждый день/)
    assert.doesNotMatch(JSON.stringify(explanation), /личную заметку/)
    const cardio = progressExplanation(before, { ...input, exerciseId: 'walking' })
    assert.equal(cardio.facts.find(fact => fact.id === 'exercise-0-pace')?.value, null)
    assert.match(cardio.insights.find(item => item.id === 'exercise-0-pace')!.text, /нет данных/)
    const bodyweight = progressExplanation(before, { ...input, exerciseId: 'push-ups' })
    assert.ok(bodyweight.facts.some(fact => fact.id === 'exercise-0-reps' && fact.value === 10))
    assert.ok(!bodyweight.facts.some(fact => /exercise-.*(weight|volume)/.test(fact.id)))
    assert.deepEqual(s.store.state('default'), before)
  } finally { s.close() }
})
