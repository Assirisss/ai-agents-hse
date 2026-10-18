import type { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import type { ChatSource, SavedTrendSource, TrendConversation, TrendConversationSummary } from '../../../shared/trend-chat.js'
import { ResearchError } from './schema.js'

/** Shares the research SQLite connection; all identifiers are scoped to a profile. */
export class TrendChatStore {
  constructor(private db: DatabaseSync, private clock = () => new Date()) {
    db.exec(`CREATE TABLE IF NOT EXISTS trend_conversations (id TEXT NOT NULL, profile_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile_id,id));
      CREATE TABLE IF NOT EXISTS trend_chat_turns (profile_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, fingerprint TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(profile_id,conversation_id,turn_id));
      CREATE TABLE IF NOT EXISTS trend_bookmarks (profile_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile_id,id));`)
  }
  create(profileId: string, initial?: Pick<TrendConversation, 'brief' | 'activeReportId' | 'sourceSelection' | 'mode'>): TrendConversation {
    const now = this.clock().toISOString()
    const conversation: TrendConversation = { id: randomUUID(), profileId, mode: 'live', title: 'Новый диалог', revision: 0, createdAt: now, updatedAt: now, brief: { query: '', domain: 'all', windowDays: 7 }, filters: {}, sourceSelection: [], reportSelection: [], activeReportId: null, messages: [], ...initial }
    this.db.prepare('INSERT INTO trend_conversations(id,profile_id,revision,updated_at,value) VALUES(?,?,?,?,?)').run(conversation.id, profileId, 0, now, JSON.stringify(conversation))
    return conversation
  }
  get(profileId: string, id: string): TrendConversation {
    const row = this.db.prepare('SELECT value FROM trend_conversations WHERE profile_id=? AND id=?').get(profileId, id)
    if (!row) throw new ResearchError('Диалог не найден в этом профиле', 404)
    const value = JSON.parse(String(row.value)) as TrendConversation
    return { ...value, mode: value.mode || 'live', filters: value.filters || {}, sourceSelection: value.sourceSelection || [], reportSelection: value.reportSelection || [] }
  }
  list(profileId: string): TrendConversationSummary[] {
    return this.db.prepare('SELECT value FROM trend_conversations WHERE profile_id=? ORDER BY updated_at DESC,id LIMIT 40').all(profileId).map((row) => {
      const conversation = JSON.parse(String(row.value)) as TrendConversation
      return { id: conversation.id, title: conversation.title, revision: conversation.revision, updatedAt: conversation.updatedAt }
    })
  }
  replay(profileId: string, id: string, turnId: string, fingerprint: string): string | null {
    const row = this.db.prepare('SELECT fingerprint,message_id FROM trend_chat_turns WHERE profile_id=? AND conversation_id=? AND turn_id=?').get(profileId, id, turnId)
    if (!row) return null
    if (row.fingerprint !== fingerprint) throw new ResearchError('Этот идентификатор сообщения уже использован для другого запроса', 409)
    return String(row.message_id)
  }
  saved(profileId: string): SavedTrendSource[] {
    return this.db.prepare("SELECT value FROM trend_bookmarks WHERE profile_id=? ORDER BY json_extract(value,'$.savedAt') DESC,id LIMIT 100").all(profileId).map((row) => JSON.parse(String(row.value)) as SavedTrendSource)
  }
  commit(conversation: TrendConversation, expectedRevision: number, turnId: string, fingerprint: string, messageId: string, bookmarks: ChatSource[], persistReports: () => void): TrendConversation {
    const updated = { ...conversation, revision: expectedRevision + 1, updatedAt: this.clock().toISOString() }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(conversation.profileId, conversation.id)
      if (current.revision !== expectedRevision) throw new ResearchError('Диалог изменился. Обновите его перед отправкой.', 409)
      persistReports()
      for (const source of bookmarks) {
        const id = createHash('sha256').update(source.url).digest('hex').slice(0, 24)
        const value: SavedTrendSource = { id, source, savedAt: updated.updatedAt }
        this.db.prepare('INSERT INTO trend_bookmarks(profile_id,id,value) VALUES(?,?,?) ON CONFLICT(profile_id,id) DO NOTHING').run(conversation.profileId, id, JSON.stringify(value))
      }
      this.db.prepare('UPDATE trend_conversations SET value=?,revision=?,updated_at=? WHERE profile_id=? AND id=?').run(JSON.stringify(updated), updated.revision, updated.updatedAt, updated.profileId, updated.id)
      this.db.prepare('INSERT INTO trend_chat_turns(profile_id,conversation_id,turn_id,fingerprint,message_id) VALUES(?,?,?,?,?)').run(updated.profileId, updated.id, turnId, fingerprint, messageId)
      this.db.exec('COMMIT')
      return updated
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
