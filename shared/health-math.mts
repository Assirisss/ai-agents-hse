import type { ExercisePoint, HealthState, HealthStats, HealthSummary, Meal, Nutrients, WorkoutEntry } from './health.js'

export const emptyNutrition = (): Nutrients => ({ calories: 0, protein: 0, fat: 0, carbs: 0 })
export function mealNutrition(meal: Pick<Meal, 'items'>): Nutrients {
  return meal.items.reduce((sum, item) => {
    for (const key of Object.keys(sum) as (keyof Nutrients)[]) sum[key] += item.product.per100[key] * item.grams / 100
    return sum
  }, emptyNutrition())
}
export function daySummary(state: HealthState, date: string): HealthSummary {
  const meals = state.meals.filter(meal => meal.date === date)
  const nutrition = meals.reduce((sum, meal) => {
    const value = mealNutrition(meal)
    for (const key of Object.keys(sum) as (keyof Nutrients)[]) sum[key] += value[key]
    return sum
  }, emptyNutrition())
  return { date, meals, nutrition, workouts: state.workouts.filter(item => item.date === date), wellbeing: state.wellbeing.find(item => item.date === date) ?? null }
}
/** Arithmetic on date labels only; diary dates never pass through a user's UTC offset. */
export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function todayInZone(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(part => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
export function adjustSets(entries: WorkoutEntry[], field: 'weight' | 'reps', delta: number): WorkoutEntry[] {
  return entries.map(entry => ({ ...entry, sets: entry.sets.map(set => ({ ...set, [field]: Math.max(field === 'reps' ? 1 : 0, set[field] + delta) })) }))
}
export function healthStats(state: HealthState, to: string, count: number, exerciseId?: string): HealthStats {
  const days = Array.from({ length: count }, (_, index) => {
    const date = shiftDate(to, index - count + 1)
    const summary = daySummary(state, date)
    const cardio = summary.workouts.flatMap(item => item.entries).filter(item => item.exercise.kind === 'cardio')
    return { date, nutrition: summary.meals.length ? summary.nutrition : null, workouts: summary.workouts.length,
      cardioMinutes: cardio.reduce((sum, item) => sum + (item.minutes ?? 0), 0), distanceKm: cardio.reduce((sum, item) => sum + (item.distanceKm ?? 0), 0), wellbeing: summary.wellbeing?.score ?? null }
  })
  const exercisePoints: ExercisePoint[] = []
  for (const day of days) {
    const entries = state.workouts.filter(item => item.date === day.date).flatMap(item => item.entries).filter(item => item.exerciseId === exerciseId)
    if (!entries.length) continue
    // Historical kinds/bodyweight modes are distinct and must not be silently mixed.
    for (const mode of ['weighted', 'bodyweight', 'cardio'] as const) {
      const matching = entries.filter(item => (item.exercise.kind === 'cardio' ? 'cardio' : item.exercise.bodyweight ? 'bodyweight' : 'weighted') === mode)
      if (!matching.length) continue
      const sets = matching.flatMap(item => item.sets)
      const minutes = matching.reduce((sum, item) => sum + (item.minutes ?? 0), 0)
      const measured = matching.filter(item => item.distanceKm !== null)
      const distance = measured.reduce((sum, item) => sum + (item.distanceKm ?? 0), 0)
      exercisePoints.push({ date: day.date, mode, sets: sets.length, reps: sets.reduce((sum, set) => sum + set.reps, 0),
        maxWeight: mode === 'weighted' ? Math.max(...sets.map(set => set.weight)) : null,
        volume: mode === 'weighted' ? sets.reduce((sum, set) => sum + set.weight * set.reps, 0) : null,
        minutes, distanceKm: measured.length ? distance : null,
        pace: distance > 0 ? measured.reduce((sum, item) => sum + (item.minutes ?? 0), 0) / distance : null })
    }
  }
  return { days, exercisePoints, workoutCount: days.reduce((sum, day) => sum + day.workouts, 0), cardioMinutes: days.reduce((sum, day) => sum + day.cardioMinutes, 0), distanceKm: days.reduce((sum, day) => sum + day.distanceKm, 0) }
}
