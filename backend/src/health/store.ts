import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HealthCollection, HealthEntityMap, HealthSettings, HealthState } from '../../../shared/health.js'
import { HealthError } from './schema.js'

type RecordValue = { id: string }
const starterExercises = [
  { id: 'squat', name: 'Приседания со штангой', kind: 'strength', bodyweight: false },
  { id: 'bench-press', name: 'Жим лёжа', kind: 'strength', bodyweight: false },
  { id: 'deadlift', name: 'Становая тяга', kind: 'strength', bodyweight: false },
  { id: 'push-ups', name: 'Отжимания', kind: 'strength', bodyweight: true },
  { id: 'pull-ups', name: 'Подтягивания', kind: 'strength', bodyweight: true },
  { id: 'running', name: 'Бег', kind: 'cardio', bodyweight: false },
  { id: 'walking', name: 'Ходьба', kind: 'cardio', bodyweight: false },
  { id: 'cycling', name: 'Велосипед', kind: 'cardio', bodyweight: false },
]
export class HealthStore {
  private db: DatabaseSync
  private closed = false
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 2) { this.db.close(); throw new Error('База спорта создана более новой версией приложения') }
    if (version === 0) this.transaction(() => this.db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, settings TEXT);
      CREATE TABLE records (profile TEXT NOT NULL REFERENCES profiles(id), kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile,kind,id));
      CREATE TABLE photos (profile TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'meals' CHECK(kind='meals'), id TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(profile,id), FOREIGN KEY(profile,kind,id) REFERENCES records(profile,kind,id) ON DELETE CASCADE);
      PRAGMA user_version=1;`))
    if (version < 2) this.transaction(() => this.db.exec(`
      CREATE TABLE ai_usage (month TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=2;`))
  }
  close() { if (!this.closed) { this.closed = true; this.db.close() } }
  aiUsage(month = new Date().toISOString().slice(0, 7)) {
    return Number(this.db.prepare('SELECT requests FROM ai_usage WHERE month=?').get(month)?.requests ?? 0)
  }
  reserveAiRequest(limit: number, month = new Date().toISOString().slice(0, 7)) {
    this.transaction(() => {
      if (this.aiUsage(month) >= limit) throw new HealthError('Месячный лимит AI-запросов исчерпан. Ручной дневник доступен.', 429)
      this.db.prepare('INSERT INTO ai_usage(month,requests) VALUES(?,1) ON CONFLICT(month) DO UPDATE SET requests=requests+1').run(month)
    })
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  ensureProfile(profile: string) {
    if (this.db.prepare('SELECT id FROM profiles WHERE id=?').get(profile)) return
    this.transaction(() => {
      this.db.prepare('INSERT INTO profiles(id) VALUES(?)').run(profile)
      for (const exercise of starterExercises) this.save(profile, 'exercises', exercise)
    })
  }
  list<K extends HealthCollection>(profile: string, kind: K): HealthEntityMap[K] {
    return this.db.prepare('SELECT value FROM records WHERE profile=? AND kind=? ORDER BY rowid DESC').all(profile, kind).map(row => JSON.parse(String(row.value))) as HealthEntityMap[K]
  }
  get<T extends RecordValue>(profile: string, kind: HealthCollection, id: string): T | null {
    const row = this.db.prepare('SELECT value FROM records WHERE profile=? AND kind=? AND id=?').get(profile, kind, id)
    return row ? JSON.parse(String(row.value)) as T : null
  }
  require<T extends RecordValue>(profile: string, kind: HealthCollection, id: string): T {
    const value = this.get<T>(profile, kind, id)
    if (!value) throw new HealthError('Запись не найдена. Обновите список.', 404)
    return value
  }
  save<T extends RecordValue>(profile: string, kind: HealthCollection, value: T): T {
    this.db.prepare('INSERT INTO records(profile,kind,id,value) VALUES(?,?,?,?) ON CONFLICT(profile,kind,id) DO UPDATE SET value=excluded.value').run(profile, kind, value.id, JSON.stringify(value))
    return value
  }
  remove(profile: string, kind: HealthCollection, id: string) {
    this.require(profile, kind, id)
    this.db.prepare('DELETE FROM records WHERE profile=? AND kind=? AND id=?').run(profile, kind, id)
  }
  photo(profile: string, id: string): Uint8Array | null {
    return (this.db.prepare('SELECT data FROM photos WHERE profile=? AND id=?').get(profile, id)?.data as Uint8Array | undefined) ?? null
  }
  savePhoto(profile: string, id: string, data: Buffer | null) {
    if (data) this.db.prepare('INSERT INTO photos(profile,id,data) VALUES(?,?,?) ON CONFLICT(profile,id) DO UPDATE SET data=excluded.data').run(profile, id, data)
    else this.db.prepare('DELETE FROM photos WHERE profile=? AND id=?').run(profile, id)
  }
  settings(profile: string): HealthSettings | null {
    const value = this.db.prepare('SELECT settings FROM profiles WHERE id=?').get(profile)?.settings
    return value ? JSON.parse(String(value)) as HealthSettings : null
  }
  saveSettings(profile: string, value: HealthSettings) {
    this.db.prepare('UPDATE profiles SET settings=? WHERE id=?').run(JSON.stringify(value), profile)
    return value
  }
  state(profile: string): HealthState {
    this.ensureProfile(profile)
    return { exercises: this.list(profile, 'exercises'), products: this.list(profile, 'products'), workouts: this.list(profile, 'workouts'), templates: this.list(profile, 'templates'), meals: this.list(profile, 'meals'), wellbeing: this.list(profile, 'wellbeing'), settings: this.settings(profile) }
  }
}
