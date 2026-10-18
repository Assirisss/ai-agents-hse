import { randomUUID } from 'node:crypto'
import type { Exercise, Product, Meal, Workout, WorkoutEntry, WorkoutTemplate, HealthCollection } from '../../../shared/health.js'
import { HealthStore } from './store.js'
import { exerciseSchema, productSchema, workoutSchema, templateSchema, mealSchema, wellbeingSchema, settingsSchema, HealthError } from './schema.js'
import { prepareMealPhoto } from './photos.js'
import { UnavailableHealthAssistant } from './ai.js'

export class HealthService {
  readonly assistant = new UnavailableHealthAssistant()
  constructor(readonly store: HealthStore) {}
  close() { this.store.close() }
  async save(profile: string, kind: HealthCollection, body: unknown, id?: string): Promise<unknown> {
    this.store.ensureProfile(profile)
    if (id) this.store.require(profile, kind, id)
    const key = id ?? randomUUID()
    if (kind === 'exercises') return this.store.save(profile, kind, { ...exerciseSchema.parse(body), id: key })
    if (kind === 'products') return this.store.save(profile, kind, { ...productSchema.parse(body), id: key })
    if (kind === 'wellbeing') {
      const value = wellbeingSchema.parse(body)
      if (id && id !== value.date) throw new HealthError('Дата отметки не может быть изменена')
      return this.store.save(profile, kind, { ...value, id: value.date })
    }
    if (kind === 'workouts' || kind === 'templates') {
      const value = kind === 'workouts' ? workoutSchema.parse(body) : templateSchema.parse(body)
      const previous = id ? this.store.require<Workout | WorkoutTemplate>(profile, kind, id) : value.source ? this.store.require<Workout | WorkoutTemplate>(profile, value.source.kind, value.source.id) : null
      const entries: WorkoutEntry[] = value.entries.map(entry => {
        const snapshot = previous?.entries.find(item => item.id === entry.id && item.exerciseId === entry.exerciseId)
        const exercise = snapshot?.exercise ?? this.store.require<Exercise>(profile, 'exercises', entry.exerciseId)
        if (exercise.kind === 'strength' && (!entry.sets.length || entry.minutes !== null || entry.distanceKm !== null)) throw new HealthError('Для силового упражнения укажите подходы, без времени и расстояния')
        if (exercise.kind === 'cardio' && (entry.minutes === null || entry.sets.length)) throw new HealthError('Для кардио укажите длительность, без силовых подходов')
        return { ...entry, exercise }
      })
      const { source: _source, ...record } = value
      return this.store.save(profile, kind, { ...record, entries, id: key })
    }
    const value = mealSchema.parse(body)
    // Image decoding is the only asynchronous work; read current snapshots after it completes.
    const photo = typeof value.photo === 'string' ? await prepareMealPhoto(value.photo) : value.photo
    return this.store.transaction(() => {
      const previous = id ? this.store.require<Meal>(profile, 'meals', id) : null
      const items = value.items.map(item => {
        const snapshot = previous?.items.find(old => old.id === item.id && old.productId === item.productId)
        return { ...item, product: snapshot?.product ?? this.store.require<Product>(profile, 'products', item.productId) }
      })
      const { photo: _photo, ...fields } = value
      const record: Meal = { ...fields, items, id: key, hasPhoto: photo === undefined ? previous?.hasPhoto ?? false : photo !== null,
        photoVersion: photo === undefined ? previous?.photoVersion ?? null : photo === null ? null : randomUUID() }
      this.store.save(profile, kind, record)
      if (photo !== undefined) this.store.savePhoto(profile, key, photo)
      return record
    })
  }
  settings(profile: string, body: unknown) {
    this.store.ensureProfile(profile)
    return this.store.saveSettings(profile, settingsSchema.parse(body))
  }
}
