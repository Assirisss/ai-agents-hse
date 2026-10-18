import { readFile } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import type { FinanceSnapshot, TelegramBinding } from '../../../shared/finance.js'

export const tables = {
  accounts: 'finance_accounts', categories: 'finance_categories', operations: 'finance_operations', drafts: 'finance_drafts',
  receipts: 'finance_receipts', audit: 'finance_audit', watchlist: 'finance_watchlist', summaries: 'finance_summaries', deliveries: 'finance_deliveries',
  conversations: 'finance_conversations', turns: 'finance_turns', payments: 'finance_payments', paymentDeliveries: 'finance_payment_deliveries',
} as const
export function emptyFinance(): FinanceSnapshot {
  return { accounts: [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 0, balance: 0, archived: false }],
    categories: [
      { id: 'food', name: 'Продукты', kind: 'expense' }, { id: 'transport', name: 'Транспорт', kind: 'expense' },
      { id: 'home', name: 'Дом', kind: 'expense' }, { id: 'other-expense', name: 'Прочее', kind: 'expense' },
      { id: 'salary', name: 'Зарплата', kind: 'income' }, { id: 'other-income', name: 'Прочие доходы', kind: 'income' },
    ], operations: [], drafts: [], receipts: [], audit: [], watchlist: [], summaries: [], deliveries: [], telegram: null, telegramPendingDraftId: null, telegramConversationId: null, conversations: [], turns: [], payments: [], paymentDeliveries: [] }
}
export interface FinanceStore {
  read(profileId: string): Promise<FinanceSnapshot>
  transact<T>(profileId: string, action: (value: FinanceSnapshot) => T | Promise<T>, signal?: AbortSignal): Promise<T>
  profiles(): Promise<string[]>
  issueCode(profileId: string, hash: string, expiresAt: string): Promise<void>
  consumeCode(hash: string, userId: string, chatId: string, now: string): Promise<boolean>
  binding(userId: string, chatId: string): Promise<string | null>
  claimUpdate(id: number): Promise<boolean>
  cursor(next?: number): Promise<number>
  close(): Promise<void>
}
/** Transactional Postgres repository. A profile row serializes every financial write. */
export class PostgresFinanceStore implements FinanceStore {
  readonly pool: Pool
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 }) }
  async migrate() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(72619821)')
      await client.query('CREATE TABLE IF NOT EXISTS finance_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      for (const [version, name] of [['001', '001_finance.sql'], ['002', '002_conversations_payments.sql']]) {
        if (!(await client.query('SELECT 1 FROM finance_migrations WHERE version=$1', [version])).rowCount) {
          const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8').catch(() => readFile(new URL(`../../../../src/finance/migrations/${name}`, import.meta.url), 'utf8'))
          await client.query(sql)
          await client.query('INSERT INTO finance_migrations(version) VALUES($1)', [version])
        }
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  private async ensure(client: PoolClient, profileId: string) {
    const result = await client.query('INSERT INTO finance_profiles(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [profileId])
    await client.query('SELECT id FROM finance_profiles WHERE id=$1 FOR UPDATE', [profileId])
    if (result.rowCount) await this.save(client, profileId, emptyFinance())
  }
  private async load(client: PoolClient, profileId: string): Promise<FinanceSnapshot> {
    const value = emptyFinance()
    for (const [field, table] of Object.entries(tables)) {
      const result = await client.query<{ value: unknown }>(`SELECT value FROM ${table} WHERE profile_id=$1 ORDER BY id`, [profileId])
      Object.assign(value, { [field]: result.rows.map((row) => row.value) })
    }
    const meta = await client.query<{ value: { telegramPendingDraftId?: string | null; telegramConversationId?: string | null } }>('SELECT value FROM finance_profiles WHERE id=$1', [profileId])
    value.telegramPendingDraftId = meta.rows[0]?.value.telegramPendingDraftId || null
    value.telegramConversationId = meta.rows[0]?.value.telegramConversationId || null
    const links = await client.query<{ chat_id: string; user_id: string; linked_at: Date }>('SELECT * FROM finance_telegram_links WHERE profile_id=$1', [profileId])
    const link = links.rows[0]
    value.telegram = link ? { chatId: link.chat_id, userId: link.user_id, linkedAt: link.linked_at.toISOString() } : null
    return value
  }
  private async save(client: PoolClient, profileId: string, value: FinanceSnapshot) {
    for (const [field, table] of Object.entries(tables)) {
      const items = value[field as keyof typeof tables] as unknown as { id?: string; ticker?: string }[]
      const ids = items.map((item) => item.id || item.ticker!)
      await client.query(`DELETE FROM ${table} WHERE profile_id=$1 AND NOT(id=ANY($2::text[]))`, [profileId, ids])
      for (let index = 0; index < items.length; index++) await client.query(`INSERT INTO ${table}(profile_id,id,value) VALUES($1,$2,$3) ON CONFLICT(profile_id,id) DO UPDATE SET value=excluded.value WHERE ${table}.value IS DISTINCT FROM excluded.value`, [profileId, ids[index], JSON.stringify(items[index])])
    }
    await client.query('UPDATE finance_profiles SET value=$2 WHERE id=$1', [profileId, JSON.stringify({ telegramPendingDraftId: value.telegramPendingDraftId, telegramConversationId: value.telegramConversationId })])
    if (value.telegram) await client.query('INSERT INTO finance_telegram_links(profile_id,user_id,chat_id,linked_at) VALUES($1,$2,$3,$4) ON CONFLICT(profile_id) DO UPDATE SET user_id=excluded.user_id,chat_id=excluded.chat_id,linked_at=excluded.linked_at', [profileId, value.telegram.userId, value.telegram.chatId, value.telegram.linkedAt])
    else await client.query('DELETE FROM finance_telegram_links WHERE profile_id=$1', [profileId])
  }
  async transact<T>(profileId: string, action: (value: FinanceSnapshot) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = await this.pool.connect()
    try {
      signal?.throwIfAborted()
      await client.query('BEGIN'); await this.ensure(client, profileId)
      const value = await this.load(client, profileId)
      const result = await action(value)
      signal?.throwIfAborted()
      await this.save(client, profileId, value)
      signal?.throwIfAborted()
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async read(profileId: string) { return this.transact(profileId, (value) => structuredClone(value)) }
  async profiles() { return (await this.pool.query<{ id: string }>('SELECT id FROM finance_profiles ORDER BY id')).rows.map((row) => row.id) }
  async issueCode(profileId: string, hash: string, expiresAt: string) {
    await this.read(profileId)
    await this.pool.query('INSERT INTO finance_link_codes(code_hash,profile_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(profile_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at', [hash, profileId, expiresAt])
  }
  async consumeCode(hash: string, userId: string, chatId: string, now: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(72619822)')
      const codes = await client.query<{ profile_id: string }>('DELETE FROM finance_link_codes WHERE code_hash=$1 AND expires_at>$2 RETURNING profile_id', [hash, now])
      const profileId = codes.rows[0]?.profile_id
      if (!profileId) { await client.query('ROLLBACK'); return false }
      await client.query('SELECT id FROM finance_profiles WHERE id=$1 FOR UPDATE', [profileId])
      const existing = await client.query('SELECT 1 FROM finance_telegram_links WHERE (user_id=$1 OR chat_id=$2) AND profile_id<>$3', [userId, chatId, profileId])
      if (existing.rowCount) { await client.query('ROLLBACK'); return false }
      await client.query('INSERT INTO finance_telegram_links(profile_id,user_id,chat_id,linked_at) VALUES($1,$2,$3,$4) ON CONFLICT(profile_id) DO UPDATE SET user_id=excluded.user_id,chat_id=excluded.chat_id,linked_at=excluded.linked_at', [profileId, userId, chatId, now])
      await client.query('COMMIT'); return true
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async binding(userId: string, chatId: string) { return (await this.pool.query<{ profile_id: string }>('SELECT profile_id FROM finance_telegram_links WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0]?.profile_id || null }
  async claimUpdate(id: number) { return Boolean((await this.pool.query('INSERT INTO finance_telegram_updates(id) VALUES($1) ON CONFLICT DO NOTHING', [id])).rowCount) }
  async cursor(next?: number) {
    if (next !== undefined) await this.pool.query("INSERT INTO finance_metadata(key,value) VALUES('telegram_cursor',$1) ON CONFLICT(key) DO UPDATE SET value=GREATEST(finance_metadata.value,excluded.value)", [JSON.stringify(next)])
    return Number((await this.pool.query<{ value: number }>("SELECT value FROM finance_metadata WHERE key='telegram_cursor'")).rows[0]?.value || 0)
  }
  async close() { await this.pool.end() }
}
/** For deterministic tests only; production always uses Postgres. */
export class MemoryFinanceStore implements FinanceStore {
  private data = new Map<string, FinanceSnapshot>()
  private codes = new Map<string, { profileId: string; expiresAt: string }>()
  private updates = new Set<number>()
  private offset = 0
  private queue: Promise<unknown> = Promise.resolve()
  async transact<T>(profileId: string, action: (value: FinanceSnapshot) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = this.queue.then(async () => {
      const value = structuredClone(this.data.get(profileId) || emptyFinance())
      signal?.throwIfAborted()
      const result = await action(value); signal?.throwIfAborted(); this.data.set(profileId, value); return structuredClone(result)
    })
    this.queue = run.catch(() => undefined); return run
  }
  async read(profileId: string) { return this.transact(profileId, (value) => value) }
  async profiles() { return [...this.data.keys()] }
  async issueCode(profileId: string, hash: string, expiresAt: string) { for (const [key, value] of this.codes) if (value.profileId === profileId) this.codes.delete(key); this.codes.set(hash, { profileId, expiresAt }) }
  async consumeCode(hash: string, userId: string, chatId: string, now: string) {
    const code = this.codes.get(hash)
    if (!code || code.expiresAt <= now) return false
    if ([...this.data.entries()].some(([id, value]) => id !== code.profileId && (value.telegram?.userId === userId || value.telegram?.chatId === chatId))) return false
    this.codes.delete(hash)
    await this.transact(code.profileId, (value) => { value.telegram = { userId, chatId, linkedAt: now } satisfies TelegramBinding }); return true
  }
  async binding(userId: string, chatId: string) { return [...this.data.entries()].find(([, value]) => value.telegram?.userId === userId && value.telegram.chatId === chatId)?.[0] || null }
  async claimUpdate(id: number) { if (this.updates.has(id)) return false; this.updates.add(id); return true }
  async cursor(next?: number) { if (next !== undefined) this.offset = Math.max(this.offset, next); return this.offset }
  async close() {}
}
