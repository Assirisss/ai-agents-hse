import { TrendChatStore } from './chat-store.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Evidence, MemoryState, MemorySummary, TrendProfile, TrendReport, TrendDomain, UserModuleContext } from '../../../shared/trends.js'
import { profileIdSchema, profileSchema, moduleContextSchema } from './schema.js'

export const emptyProfile = (id: string): TrendProfile => ({ id, interests: [], goals: [], context: [], excludedTopics: [], experience: '', allowInterestQueries: false, updatedAt: '' })
export const words = (text: string) => [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0, 40)

export class TrendMemory {
  private db: DatabaseSync
  private closed = false
  readonly persistent: boolean
  readonly chats: TrendChatStore
  constructor(path = ':memory:', private clock = () => new Date()) {
    this.persistent = path !== ':memory:'
    if (this.persistent) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (this.persistent) chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS module_contexts (profile_id TEXT NOT NULL, module TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile_id,module));
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, created_at TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_by_profile ON research_runs(profile_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS observed_articles (profile_id TEXT NOT NULL, url TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(profile_id,url,mode));
      CREATE TABLE IF NOT EXISTS seen_resources (profile_id TEXT NOT NULL, url TEXT NOT NULL, mode TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY(profile_id,url,mode));
      CREATE TABLE IF NOT EXISTS relevance_feedback (profile_id TEXT NOT NULL, url TEXT NOT NULL, verdict TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(profile_id,url));`)
    this.chats = new TrendChatStore(this.db, this.clock)
  }
  profile(id = 'default'): TrendProfile {
    profileIdSchema.parse(id)
    const row = this.db.prepare('SELECT value FROM profiles WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as TrendProfile : emptyProfile(id)
  }
  saveProfile(id: string, value: unknown): TrendProfile {
    profileIdSchema.parse(id)
    const profile = { ...profileSchema.parse(value), id, updatedAt: this.clock().toISOString() }
    this.db.prepare('INSERT INTO profiles(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(profile))
    return profile
  }
  moduleContexts(id: string): UserModuleContext[] {
    return this.db.prepare('SELECT value FROM module_contexts WHERE profile_id=? ORDER BY module').all(id).map((row) => JSON.parse(String(row.value)) as UserModuleContext)
  }
  saveModuleContext(id: string, value: unknown): UserModuleContext {
    profileIdSchema.parse(id)
    const context = { ...moduleContextSchema.parse(value), updatedAt: this.clock().toISOString() }
    this.db.prepare('INSERT INTO module_contexts(profile_id,module,value) VALUES(?,?,?) ON CONFLICT(profile_id,module) DO UPDATE SET value=excluded.value').run(id, context.module, JSON.stringify(context))
    return context
  }
  archive(id: string, articles: Evidence[], mode: string) {
    if (mode !== 'live') return
    const insert = this.db.prepare('INSERT INTO observed_articles(profile_id,url,mode,value,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,url,mode) DO UPDATE SET last_seen=excluded.last_seen')
    this.db.exec('BEGIN')
    try {
      for (const article of articles) insert.run(id, article.url, mode, JSON.stringify(article), this.clock().toISOString())
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  archived(id: string): Evidence[] {
    return this.db.prepare("SELECT value FROM observed_articles WHERE profile_id=? AND mode='live' ORDER BY last_seen DESC LIMIT 3000").all(id).map((row) => JSON.parse(String(row.value)) as Evidence)
  }
  saveReport(id: string, report: TrendReport) {
    this.db.prepare('INSERT INTO research_runs(id,profile_id,created_at,mode,value) VALUES(?,?,?,?,?)').run(report.id, id, report.generatedAt, report.request.mode, JSON.stringify(report))
    const remember = this.db.prepare('INSERT INTO seen_resources(profile_id,url,mode,seen_at) VALUES(?,?,?,?) ON CONFLICT(profile_id,url,mode) DO UPDATE SET seen_at=excluded.seen_at')
    for (const item of [...report.articles, ...(report.webResults || [])]) remember.run(id, item.url, report.request.mode, report.generatedAt)
  }
  private summarize(report: TrendReport): MemorySummary {
    return { id: report.id, query: report.request.query, domain: report.request.domain, mode: report.request.mode, createdAt: report.generatedAt,
      summary: report.agent?.summary || report.analysis.summary || report.trends.map((trend) => trend.title).join('; '),
      articleCount: report.articles.length, webCount: report.webResults?.length || 0 }
  }
  recall(id: string, query = '', mode?: string, domain?: TrendDomain): MemorySummary[] {
    const rows = mode
      ? this.db.prepare('SELECT value FROM research_runs WHERE profile_id=? AND mode=? ORDER BY created_at DESC LIMIT 100').all(id, mode)
      : this.db.prepare('SELECT value FROM research_runs WHERE profile_id=? ORDER BY created_at DESC LIMIT 100').all(id)
    const terms = words(query)
    return rows.map((row) => this.summarize(JSON.parse(String(row.value)) as TrendReport))
      .filter((run) => !domain || domain === 'all' || run.domain === domain)
      .map((run) => ({ run, score: terms.reduce((score, term) => score + Number(`${run.query} ${run.summary}`.toLocaleLowerCase().includes(term)), 0) }))
      .filter((item) => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || b.run.createdAt.localeCompare(a.run.createdAt)).slice(0, 20).map((item) => item.run)
  }
  report(id: string, runId: string): TrendReport | null {
    const row = this.db.prepare('SELECT value FROM research_runs WHERE profile_id=? AND id=?').get(id, runId)
    return row ? JSON.parse(String(row.value)) as TrendReport : null
  }
  forget(id: string, runId: string): boolean {
    return Number(this.db.prepare('DELETE FROM research_runs WHERE profile_id=? AND id=?').run(id, runId).changes) > 0
  }
  feedback(id: string, url: string, verdict: 'useful' | 'not_useful') {
    this.db.prepare('INSERT INTO relevance_feedback(profile_id,url,verdict,updated_at) VALUES(?,?,?,?) ON CONFLICT(profile_id,url) DO UPDATE SET verdict=excluded.verdict, updated_at=excluded.updated_at').run(id, url, verdict, this.clock().toISOString())
  }
  verdict(id: string, url: string): string | null {
    return String(this.db.prepare('SELECT verdict FROM relevance_feedback WHERE profile_id=? AND url=?').get(id, url)?.verdict || '') || null
  }
  seen(id: string, url: string, mode: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM seen_resources WHERE profile_id=? AND url=? AND mode=?').get(id, url, mode))
  }
  state(id: string, query = ''): MemoryState {
    return { runs: this.recall(id, query),
      articleCount: Number(this.db.prepare('SELECT count(*) AS n FROM observed_articles WHERE profile_id=?').get(id)?.n || 0),
      feedbackCount: Number(this.db.prepare('SELECT count(*) AS n FROM relevance_feedback WHERE profile_id=?').get(id)?.n || 0) }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true } }
}
