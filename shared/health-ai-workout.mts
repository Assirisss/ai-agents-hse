import type { Exercise, HealthAiWorkout } from './health.js'

export type HealthAiWorkoutEntry = HealthAiWorkout['entries'][number]

/** Catalog metadata is authoritative; incompatible measurements are never converted. */
export function normalizeAiWorkoutEntry(entry: HealthAiWorkoutEntry, exercise?: Exercise): HealthAiWorkoutEntry {
  const kind = exercise?.kind ?? entry.kind
  return {
    ...entry,
    exerciseId: exercise?.id ?? null,
    name: exercise?.name ?? entry.name,
    kind,
    bodyweight: kind === 'cardio' ? false : exercise?.bodyweight ?? entry.bodyweight,
    sets: kind === 'cardio' ? [] : entry.sets.map(set => ({ ...set })),
    minutes: kind === 'strength' ? null : entry.minutes,
    distanceKm: kind === 'strength' ? null : entry.distanceKm,
  }
}
