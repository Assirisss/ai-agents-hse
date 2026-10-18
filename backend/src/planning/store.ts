import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { CalendarAccount, CalendarProvider, ConnectedCalendar, PlanningDraft, PlanningEvent, PlanningSettings, PlanningTask, SyncReport, TelegramChat } from '../../../shared/planning.js'
import { defaultSettings } from './schema.js'
import type { SecretBox } from './secrets.js'

/** Link between a local event and its copy in an external calendar. */
export type RemoteLink = { remoteId: string; etag: string; raw: string | null; remoteUpdated: string | null; syncedAt: string }
export type EventRow = { event: PlanningEvent; link: RemoteLink | null; deletedAt: string | null }
export type AccountRecord = Omit<CalendarAccount, 'calendars'> & { profileId: string }
export type CalendarRecord = ConnectedCalendar & { profileId: string; provider: CalendarProvider }

type Row = Record<string, string | number | null>

export class PlanningStore {
  private db: DatabaseSync
  readonly persistent: boolean
  constructor(path = ':memory:', private box: SecretBox, private clock = () => new Date()) {
    this.persistent = path !== ':memory:'
    if (this.persistent) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (this.persistent) chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (profile_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, calendar_id TEXT, value TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        remote_id TEXT, remote_etag TEXT, remote_raw TEXT, remote_updated TEXT, synced_at TEXT);
      CREATE INDEX IF NOT EXISTS events_by_profile ON events(profile_id, deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS events_by_remote ON events(calendar_id, remote_id) WHERE remote_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_by_profile ON tasks(profile_id, status);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider TEXT NOT NULL, label TEXT NOT NULL, secret TEXT NOT NULL,
        status TEXT NOT NULL, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendars (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, profile_id TEXT NOT NULL,
        remote_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, writable INTEGER NOT NULL, enabled INTEGER NOT NULL, UNIQUE(account_id, remote_id));
      CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_chats (chat_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, title TEXT NOT NULL, linked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_codes (code TEXT PRIMARY KEY, profile_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (key TEXT PRIMARY KEY, profile_id TEXT NOT NULL, sent_at TEXT NOT NULL);`)
  }
  private closed = false
  close() { if (!this.closed) { this.closed = true; this.db.close() } }
  private now() { return this.clock().toISOString() }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  // Settings
  settings(profileId: string): PlanningSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE profile_id=?').get(profileId) as Row | undefined
    return { ...defaultSettings, ...(row ? JSON.parse(String(row.value)) : {}) }
  }
  /** False until the profile saved settings once: then no choice was made yet, defaults may be filled in. */
  hasSettings(profileId: string) { return Boolean(this.db.prepare('SELECT 1 FROM settings WHERE profile_id=?').get(profileId)) }
  saveSettings(profileId: string, value: PlanningSettings) {
    this.db.prepare('INSERT INTO settings(profile_id,value) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET value=excluded.value').run(profileId, JSON.stringify(value))
    return value
  }
  profiles(): string[] {
    const ids = new Set<string>(['default'])
    for (const row of this.db.prepare('SELECT profile_id FROM settings UNION SELECT profile_id FROM telegram_chats UNION SELECT profile_id FROM accounts').all() as Row[]) ids.add(String(row.profile_id))
    return [...ids]
  }

  // Events
  private toEventRow(row: Row): EventRow {
    const link = row.remote_id ? { remoteId: String(row.remote_id), etag: String(row.remote_etag || ''), raw: row.remote_raw === null ? null : String(row.remote_raw), remoteUpdated: row.remote_updated === null ? null : String(row.remote_updated), syncedAt: String(row.synced_at || '') } : null
    return { event: JSON.parse(String(row.value)) as PlanningEvent, link, deletedAt: row.deleted_at === null ? null : String(row.deleted_at) }
  }
  events(profileId: string): PlanningEvent[] {
    return (this.db.prepare('SELECT value FROM events WHERE profile_id=? AND deleted_at IS NULL').all(profileId) as Row[]).map((row) => JSON.parse(String(row.value)) as PlanningEvent)
  }
  eventRow(profileId: string, id: string): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE profile_id=? AND id=?').get(profileId, id) as Row | undefined
    return row ? this.toEventRow(row) : null
  }
  event(profileId: string, id: string) {
    const row = this.eventRow(profileId, id)
    return row && !row.deletedAt ? row.event : null
  }
  /** Every row of a calendar, including tombstones that still have to be deleted remotely. */
  calendarRows(calendarId: string): EventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE calendar_id=?').all(calendarId) as Row[]).map((row) => this.toEventRow(row))
  }
  saveEvent(profileId: string, event: PlanningEvent, link?: RemoteLink | null) {
    const current = this.db.prepare('SELECT remote_id FROM events WHERE id=?').get(event.id) as Row | undefined
    if (!current) {
      this.db.prepare('INSERT INTO events(id,profile_id,calendar_id,value,updated_at,deleted_at,remote_id,remote_etag,remote_raw,remote_updated,synced_at) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)')
        .run(event.id, profileId, event.calendarId, JSON.stringify(event), event.updatedAt, link?.remoteId ?? null, link?.etag ?? null, link?.raw ?? null, link?.remoteUpdated ?? null, link?.syncedAt ?? null)
    } else {
      this.db.prepare('UPDATE events SET calendar_id=?, value=?, updated_at=?, deleted_at=NULL WHERE id=?').run(event.calendarId, JSON.stringify(event), event.updatedAt, event.id)
      if (link !== undefined) this.setLink(event.id, link)
    }
    return event
  }
  setLink(id: string, link: RemoteLink | null) {
    this.db.prepare('UPDATE events SET remote_id=?, remote_etag=?, remote_raw=?, remote_updated=?, synced_at=? WHERE id=?')
      .run(link?.remoteId ?? null, link?.etag ?? null, link?.raw ?? null, link?.remoteUpdated ?? null, link?.syncedAt ?? null, id)
  }
  /** A tombstone keeps the remote link until the deletion is pushed; local-only rows disappear at once. */
  deleteEvent(profileId: string, id: string) {
    return this.transaction(() => {
      const ids = [id, ...(this.db.prepare(`SELECT id FROM events WHERE profile_id=? AND json_extract(value,'$.recurrenceOf')=?`).all(profileId, id) as Row[]).map((row) => String(row.id))]
      for (const item of ids) {
        const row = this.db.prepare('SELECT remote_id FROM events WHERE profile_id=? AND id=?').get(profileId, item) as Row | undefined
        if (!row) continue
        if (row.remote_id) this.db.prepare('UPDATE events SET deleted_at=? WHERE id=?').run(this.now(), item)
        else this.db.prepare('DELETE FROM events WHERE id=?').run(item)
      }
      return ids.length
    })
  }
  purgeEvent(id: string) { this.db.prepare('DELETE FROM events WHERE id=?').run(id) }
  children(parentId: string): EventRow[] {
    return (this.db.prepare(`SELECT * FROM events WHERE json_extract(value,'$.recurrenceOf')=?`).all(parentId) as Row[]).map((row) => this.toEventRow(row))
  }

  // Tasks
  tasks(profileId: string): PlanningTask[] {
    return (this.db.prepare('SELECT value FROM tasks WHERE profile_id=?').all(profileId) as Row[]).map((row) => JSON.parse(String(row.value)) as PlanningTask)
  }
  task(profileId: string, id: string): PlanningTask | null {
    const row = this.db.prepare('SELECT value FROM tasks WHERE profile_id=? AND id=?').get(profileId, id) as Row | undefined
    return row ? JSON.parse(String(row.value)) as PlanningTask : null
  }
  saveTask(profileId: string, task: PlanningTask) {
    this.db.prepare('INSERT INTO tasks(id,profile_id,value,status,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, status=excluded.status, updated_at=excluded.updated_at')
      .run(task.id, profileId, JSON.stringify(task), task.status, task.updatedAt)
    return task
  }
  deleteTask(profileId: string, id: string) { return Number(this.db.prepare('DELETE FROM tasks WHERE profile_id=? AND id=?').run(profileId, id).changes) > 0 }

  // Drafts expire after a day: they are proposals, not records.
  saveDraft(profileId: string, draft: PlanningDraft) {
    this.db.prepare('DELETE FROM drafts WHERE created_at < ?').run(new Date(this.clock().getTime() - 86400000).toISOString())
    this.db.prepare('INSERT INTO drafts(id,profile_id,value,created_at) VALUES(?,?,?,?)').run(draft.id, profileId, JSON.stringify(draft), draft.createdAt)
    return draft
  }
  draft(profileId: string, id: string): PlanningDraft | null {
    const row = this.db.prepare('SELECT value FROM drafts WHERE profile_id=? AND id=?').get(profileId, id) as Row | undefined
    return row ? JSON.parse(String(row.value)) as PlanningDraft : null
  }
  deleteDraft(profileId: string, id: string) { return Number(this.db.prepare('DELETE FROM drafts WHERE profile_id=? AND id=?').run(profileId, id).changes) > 0 }

  // Accounts and calendars
  private account(row: Row): AccountRecord {
    return { id: String(row.id), profileId: String(row.profile_id), provider: String(row.provider) as CalendarProvider, label: String(row.label), status: String(row.status) as CalendarAccount['status'],
      lastSyncAt: row.last_sync_at === null ? null : String(row.last_sync_at), lastError: row.last_error === null ? null : String(row.last_error), createdAt: String(row.created_at) }
  }
  private calendar(row: Row): CalendarRecord {
    return { id: String(row.id), accountId: String(row.account_id), profileId: String(row.profile_id), provider: String(row.provider) as CalendarProvider, remoteId: String(row.remote_id),
      name: String(row.name), color: String(row.color), writable: Boolean(row.writable), enabled: Boolean(row.enabled) }
  }
  accounts(profileId: string): CalendarAccount[] {
    const calendars = this.calendars(profileId)
    return (this.db.prepare('SELECT * FROM accounts WHERE profile_id=? ORDER BY created_at').all(profileId) as Row[]).map((row) => {
      const { profileId: _profile, ...account } = this.account(row)
      return { ...account, calendars: calendars.filter((item) => item.accountId === account.id).map(({ profileId: _p, provider: _v, ...item }) => item) }
    })
  }
  accountRecord(id: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Row | undefined
    return row ? this.account(row) : null
  }
  accountSecret<T>(id: string): T {
    const row = this.db.prepare('SELECT secret FROM accounts WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('Аккаунт не найден')
    return this.box.open<T>(String(row.secret))
  }
  /** One account per provider and login: reconnecting replaces credentials and keeps calendars. */
  saveAccount(profileId: string, provider: CalendarProvider, label: string, secret: unknown): AccountRecord {
    const existing = this.db.prepare('SELECT id FROM accounts WHERE profile_id=? AND provider=? AND label=?').get(profileId, provider, label) as Row | undefined
    const id = existing ? String(existing.id) : randomUUID()
    if (existing) this.db.prepare(`UPDATE accounts SET secret=?, status='ok', last_error=NULL WHERE id=?`).run(this.box.seal(secret), id)
    else this.db.prepare(`INSERT INTO accounts(id,profile_id,provider,label,secret,status,last_sync_at,last_error,created_at) VALUES(?,?,?,?,?,'ok',NULL,NULL,?)`).run(id, profileId, provider, label, this.box.seal(secret), this.now())
    return this.accountRecord(id)!
  }
  updateAccountSecret(id: string, secret: unknown) { this.db.prepare('UPDATE accounts SET secret=? WHERE id=?').run(this.box.seal(secret), id) }
  updateAccountStatus(id: string, status: CalendarAccount['status'], error: string | null, syncedAt?: string) {
    this.db.prepare('UPDATE accounts SET status=?, last_error=?, last_sync_at=COALESCE(?, last_sync_at) WHERE id=?').run(status, error, syncedAt ?? null, id)
  }
  /** Imported events disappear with the account; events created here stay as local events. */
  deleteAccount(profileId: string, id: string) {
    return this.transaction(() => {
      const calendarIds = (this.db.prepare('SELECT id FROM calendars WHERE account_id=?').all(id) as Row[]).map((row) => String(row.id))
      for (const calendarId of calendarIds) this.detach(profileId, calendarId)
      return Number(this.db.prepare('DELETE FROM accounts WHERE profile_id=? AND id=?').run(profileId, id).changes) > 0
    })
  }
  private detach(profileId: string, calendarId: string) {
    for (const row of this.calendarRows(calendarId)) {
      if (['google', 'yandex'].includes(row.event.source) || row.deletedAt || row.event.recurrenceOf) this.purgeEvent(row.event.id)
      else { this.saveEvent(profileId, { ...row.event, calendarId: null, updatedAt: this.now() }); this.setLink(row.event.id, null) }
    }
    const settings = this.settings(profileId)
    if (settings.defaultCalendarId === calendarId) this.saveSettings(profileId, { ...settings, defaultCalendarId: null })
  }
  calendars(profileId: string): CalendarRecord[] {
    return (this.db.prepare('SELECT c.*, a.provider FROM calendars c JOIN accounts a ON a.id=c.account_id WHERE c.profile_id=? ORDER BY a.created_at, c.name').all(profileId) as Row[]).map((row) => this.calendar(row))
  }
  calendarRecord(id: string): CalendarRecord | null {
    const row = this.db.prepare('SELECT c.*, a.provider FROM calendars c JOIN accounts a ON a.id=c.account_id WHERE c.id=?').get(id) as Row | undefined
    return row ? this.calendar(row) : null
  }
  /** New calendars start disabled except the primary one: the user chooses what to synchronize. */
  upsertCalendars(account: AccountRecord, items: { remoteId: string; name: string; color: string; writable: boolean; primary: boolean }[]) {
    return this.transaction(() => {
      for (const item of items) {
        const existing = this.db.prepare('SELECT id FROM calendars WHERE account_id=? AND remote_id=?').get(account.id, item.remoteId) as Row | undefined
        if (existing) this.db.prepare('UPDATE calendars SET name=?, color=?, writable=? WHERE id=?').run(item.name, item.color, item.writable ? 1 : 0, existing.id)
        else this.db.prepare('INSERT INTO calendars(id,account_id,profile_id,remote_id,name,color,writable,enabled) VALUES(?,?,?,?,?,?,?,?)')
          .run(randomUUID(), account.id, account.profileId, item.remoteId, item.name, item.color, item.writable ? 1 : 0, item.primary ? 1 : 0)
      }
      return this.calendars(account.profileId).filter((item) => item.accountId === account.id)
    })
  }
  /** Turning synchronization off removes imported copies; events created here stay as local ones. */
  setCalendarEnabled(profileId: string, id: string, enabled: boolean) {
    return this.transaction(() => {
      const changed = Number(this.db.prepare('UPDATE calendars SET enabled=? WHERE profile_id=? AND id=?').run(enabled ? 1 : 0, profileId, id).changes) > 0
      if (changed && !enabled) this.detach(profileId, id)
      return changed
    })
  }

  // Synchronization journal keeps the latest 100 reports per profile.
  addSyncReport(profileId: string, report: SyncReport) {
    this.db.prepare('INSERT INTO sync_log(profile_id,at,value) VALUES(?,?,?)').run(profileId, report.at, JSON.stringify(report))
    this.db.prepare('DELETE FROM sync_log WHERE profile_id=? AND id NOT IN (SELECT id FROM sync_log WHERE profile_id=? ORDER BY id DESC LIMIT 100)').run(profileId, profileId)
  }
  syncLog(profileId: string, limit = 20): SyncReport[] {
    return (this.db.prepare('SELECT value FROM sync_log WHERE profile_id=? ORDER BY id DESC LIMIT ?').all(profileId, limit) as Row[]).map((row) => JSON.parse(String(row.value)) as SyncReport)
  }

  // Application-wide secrets: OAuth client and bot token.
  secret<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM app_secrets WHERE key=?').get(key) as Row | undefined
    return row ? this.box.open<T>(String(row.value)) : null
  }
  setSecret(key: string, value: unknown) { this.db.prepare('INSERT INTO app_secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, this.box.seal(value)) }
  deleteSecret(key: string) { this.db.prepare('DELETE FROM app_secrets WHERE key=?').run(key) }

  // Telegram: only chats linked by a one-time code receive data.
  createLinkCode(profileId: string, minutes = 15) {
    const code = randomBytes(9).toString('base64url')
    const expiresAt = new Date(this.clock().getTime() + minutes * 60000).toISOString()
    this.db.prepare('DELETE FROM telegram_codes WHERE expires_at < ? OR profile_id=?').run(this.now(), profileId)
    this.db.prepare('INSERT INTO telegram_codes(code,profile_id,expires_at) VALUES(?,?,?)').run(code, profileId, expiresAt)
    return { code, expiresAt }
  }
  consumeLinkCode(code: string): string | null {
    const row = this.db.prepare('SELECT profile_id, expires_at FROM telegram_codes WHERE code=?').get(code) as Row | undefined
    this.db.prepare('DELETE FROM telegram_codes WHERE code=?').run(code)
    return row && String(row.expires_at) > this.now() ? String(row.profile_id) : null
  }
  linkChat(chatId: string, profileId: string, title: string) {
    this.db.prepare('INSERT INTO telegram_chats(chat_id,profile_id,title,linked_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET profile_id=excluded.profile_id, title=excluded.title, linked_at=excluded.linked_at').run(chatId, profileId, title, this.now())
  }
  unlinkChat(chatId: string) { return Number(this.db.prepare('DELETE FROM telegram_chats WHERE chat_id=?').run(chatId).changes) > 0 }
  chatProfile(chatId: string): string | null {
    const row = this.db.prepare('SELECT profile_id FROM telegram_chats WHERE chat_id=?').get(chatId) as Row | undefined
    return row ? String(row.profile_id) : null
  }
  chats(profileId?: string): (TelegramChat & { profileId: string })[] {
    const rows = (profileId ? this.db.prepare('SELECT * FROM telegram_chats WHERE profile_id=? ORDER BY linked_at').all(profileId) : this.db.prepare('SELECT * FROM telegram_chats ORDER BY linked_at').all()) as Row[]
    return rows.map((row) => ({ chatId: String(row.chat_id), profileId: String(row.profile_id), title: String(row.title), linkedAt: String(row.linked_at) }))
  }

  // Notification journal prevents duplicates after restarts.
  wasNotified(key: string) { return Boolean(this.db.prepare('SELECT 1 FROM notifications WHERE key=?').get(key)) }
  markNotified(profileId: string, key: string) {
    this.db.prepare('INSERT OR IGNORE INTO notifications(key,profile_id,sent_at) VALUES(?,?,?)').run(key, profileId, this.now())
    this.db.prepare('DELETE FROM notifications WHERE sent_at < ?').run(new Date(this.clock().getTime() - 45 * 86400000).toISOString())
  }
}
