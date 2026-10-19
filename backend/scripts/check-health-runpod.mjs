/** Explicit paid smoke test. Run only after deploying the dedicated vision endpoint. */
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { healthAssistantFromEnvironment } from '../dist/backend/src/health/ai.js'
import { HealthService } from '../dist/backend/src/health/service.js'
import { HealthStore } from '../dist/backend/src/health/store.js'

if (!process.argv.includes('--live')) {
  console.log('This check sends five PAID Runpod requests. To run: node scripts/check-health-runpod.mjs --live [--only=workout,non-food,label,progress,suggestion]')
  process.exit(0)
}
if (existsSync('.env')) loadEnvFile('.env')
const names = ['workout', 'non-food', 'label', 'progress', 'suggestion']
const selected = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',') ?? names
assert.ok(selected.length && selected.every(name => names.includes(name)), 'Unknown check name')
// Print job IDs and timings, never request headers, API keys, prompts or image bytes.
const originalFetch = globalThis.fetch, terminalJobs = new Set()
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args)
  const url = new URL(String(args[0]))
  if (url.origin === 'https://api.runpod.ai' && response.ok) {
    const body = await response.clone().json()
    if (url.pathname.endsWith('/run') || ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(body.status) && !terminalJobs.has(body.id)) {
      console.log(JSON.stringify({ jobId: body.id, status: body.status, executionMs: body.executionTime, delayMs: body.delayTime }))
      if (body.status !== 'IN_QUEUE' && body.status !== 'IN_PROGRESS') terminalJobs.add(body.id)
    }
  }
  return response
}
const assistant = healthAssistantFromEnvironment()
assert.ok(assistant.configured, 'Configure HEALTH_RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY first')
const service = new HealthService(new HealthStore(), assistant, selected.length)
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
const date = '2026-10-19'
const report = (name, reply, evidence) => console.log(JSON.stringify({ check: name, operation: reply.operation, model: reply.model, executionMs: reply.executionMs, delayMs: reply.delayMs, message: reply.message, questions: reply.questions, warnings: reply.warnings, evidence, result: 'PASS' }))
try {
  const before = service.store.state('default')
  if (selected.includes('workout')) {
    const workout = await service.assist('default', 'parse-workout', { date, text: 'Жим лёжа: 3 подхода по 10 повторений с весом 40 кг.' }, controller.signal)
    assert.equal(workout.status, 'completed')
    assert.equal(workout.workout?.entries[0]?.exerciseId, 'bench-press')
    assert.deepEqual(workout.workout.entries[0].sets, Array.from({ length: 3 }, () => ({ reps: 10, weight: 40 })))
    report('workout', workout, workout.workout.entries)
  }
  if (selected.includes('non-food')) {
    // Synthetic non-food image exercises image transport without sending private photos.
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const food = await service.assist('default', 'recognize-food', { date, mode: 'dish', text: 'Определи, есть ли на изображении еда.', photo: `data:image/png;base64,${bytes.toString('base64')}` }, controller.signal)
    assert.equal(food.status, 'completed')
    assert.deepEqual(food.food?.components, [])
    assert.equal(food.food?.label, null)
    report('non-food', food, food.food)
  }
  if (selected.includes('label')) {
    // Exact values exist only in the generated image, not in the text sent to the model.
    const rows = ['Graphite Test Bar', 'Nutrition per 100 g', 'Energy: 250 kcal', 'Protein: 12 g', 'Fat: 8 g', 'Carbohydrate: 30 g']
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="sans-serif" font-size="46">${rows.map((row, i) => `<text x="60" y="${90 + i * 100}">${row}</text>`).join('')}</g></svg>`
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer()
    const label = await service.assist('default', 'recognize-food', { date, mode: 'label', text: 'Прочитай этикетку.', photo: `data:image/png;base64,${bytes.toString('base64')}` }, controller.signal)
    assert.equal(label.status, 'completed')
    assert.deepEqual(label.food?.label?.per100, { calories: 250, protein: 12, fat: 8, carbs: 30 })
    report('label', label, label.food.label)
  }
  if (selected.includes('progress')) {
    const progress = await service.assist('default', 'explain-progress', { to: date, days: 7 }, controller.signal)
    assert.equal(progress.status, 'completed')
    assert.ok(progress.message.trim(), 'Empty periods still need an explanation')
    assert.ok(progress.observations.every(item => progress.facts.some(fact => fact.id === item.factId)))
    assert.equal(progress.facts.find(fact => fact.id === 'calories')?.value, null)
    report('progress', progress, progress.observations)
  }
  if (selected.includes('suggestion')) {
    const suggestion = await service.assist('default', 'suggest-workout', { date, text: 'Спокойная тренировка для начинающего без рабочих весов.', location: 'home', minutes: 20, equipment: 'Без оборудования, есть место для ходьбы', experience: 'beginner' }, controller.signal)
    assert.equal(suggestion.status, 'completed')
    assert.ok(suggestion.workout?.entries.length)
    assert.ok(suggestion.workout.entries.every(entry => before.exercises.some(exercise => exercise.id === entry.exerciseId) && entry.sets.every(set => set.weight === null)))
    report('suggestion', suggestion, suggestion.workout.entries)
  }
  assert.deepEqual(service.store.state('default'), before, 'AI must not modify diary or catalog')
  console.log('PASS: selected integration checks; synthetic fixtures are not a food accuracy benchmark')
} finally { service.close(); globalThis.fetch = originalFetch }
