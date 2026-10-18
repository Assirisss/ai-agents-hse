import { randomUUID } from 'node:crypto'
import type { CalendarProvider, PlanningEvent, SyncConflict, SyncReport } from '../../../shared/planning.js'
import type { RemoteEventData } from './ical.js'
import { occurrenceKey } from './recurrence.js'
import type { AccountRecord, CalendarRecord, EventRow, PlanningStore } from './store.js'

export type RemoteCalendarInfo = { remoteId: string; name: string; color: string; writable: boolean; primary: boolean }

/** A remote object: a single event or a series with its changed occurrences. */
export type RemoteItem = {
  remoteId: string
  etag: string
  updated: string | null
  deleted: boolean
  master: RemoteEventData | null
  /** Changed or cancelled occurrences stored inside the same resource (CalDAV). */
  exceptions: RemoteEventData[]
  /** A separately addressable occurrence of another series (Google instances). */
  parentRemoteId: string | null
  raw: string | null
}
export type SavedRemote = { remoteId: string; etag: string; updated: string | null; raw: string | null }

export interface CalendarClient {
  readonly provider: CalendarProvider
  /** Google instances can be edited one by one; CalDAV exceptions only together with their series. */
  readonly editableExceptions: boolean
  listCalendars(): Promise<RemoteCalendarInfo[]>
  list(calendarId: string, from: Date, to: Date): Promise<RemoteItem[]>
  get(calendarId: string, remoteId: string): Promise<RemoteItem | null>
  create(calendarId: string, event: PlanningEvent): Promise<SavedRemote>
  update(calendarId: string, remoteId: string, etag: string, event: PlanningEvent, raw: string | null): Promise<SavedRemote>
  remove(calendarId: string, remoteId: string, etag: string): Promise<void>
}

/** The remote copy changed since we read it (HTTP 412). */
export class PreconditionFailed extends Error {}
/** Credentials were rejected: the user has to reconnect. */
export class AuthError extends Error {}

const windowPastDays = 30
const windowFutureDays = 365

/**
 * Two-way synchronization of one calendar.
 * - A remote change is detected by its ETag, a local change by updatedAt > syncedAt.
 * - Both changed: the newer timestamp wins and the conflict is written to the journal.
 * - A linked event missing from the time window is fetched directly before it is treated as deleted.
 * Every step is deterministic; no model takes part in synchronization.
 */
export class SyncEngine {
  private running = new Map<string, Promise<SyncReport[]>>()
  constructor(private store: PlanningStore, private clientFor: (account: AccountRecord) => CalendarClient, private clock = () => new Date()) {}

  syncAccount(account: AccountRecord): Promise<SyncReport[]> {
    const current = this.running.get(account.id)
    if (current) return current
    const work = this.run(account).finally(() => this.running.delete(account.id))
    this.running.set(account.id, work)
    return work
  }

  private async run(account: AccountRecord) {
    const reports: SyncReport[] = []
    try {
      const client = this.clientFor(account)
      for (const calendar of this.store.calendars(account.profileId).filter((item) => item.accountId === account.id && item.enabled)) {
        const report = await this.syncCalendar(client, calendar)
        this.store.addSyncReport(account.profileId, report)
        reports.push(report)
      }
      const errors = reports.flatMap((report) => report.errors)
      this.store.updateAccountStatus(account.id, errors.length ? 'error' : 'ok', errors[0] ?? null, this.clock().toISOString())
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Ошибка синхронизации'
      this.store.updateAccountStatus(account.id, error instanceof AuthError ? 'needs_auth' : 'error', message)
      throw error
    }
    return reports
  }

  async syncCalendar(client: CalendarClient, calendar: CalendarRecord): Promise<SyncReport> {
    const now = this.clock()
    const timeZone = this.store.settings(calendar.profileId).timeZone
    const report: SyncReport = { accountId: calendar.accountId, calendarId: calendar.id, calendarName: calendar.name, at: now.toISOString(), pulled: { created: 0, updated: 0, deleted: 0 }, pushed: { created: 0, updated: 0, deleted: 0 }, conflicts: [], errors: [] }
    const conflict = (event: PlanningEvent, kept: SyncConflict['kept'], reason: string) => report.conflicts.push({ eventId: event.id, title: event.title, kept, reason })
    const stamp = () => this.clock().toISOString()
    const items = await client.list(calendar.remoteId, new Date(now.getTime() - windowPastDays * 86400000), new Date(now.getTime() + windowFutureDays * 86400000))
    const rows = this.store.calendarRows(calendar.id)
    const byRemote = new Map(rows.filter((row) => row.link).map((row) => [row.link!.remoteId, row]))
    const syntheticChild = (row: EventRow) => Boolean(row.event.recurrenceOf && !client.editableExceptions)

    const toEvent = (data: RemoteEventData, base: Partial<PlanningEvent>, parent: EventRow | null): PlanningEvent => ({
      id: base.id ?? randomUUID(), title: data.title, description: data.description, location: data.location, allDay: data.allDay, start: data.start, end: data.end,
      timeZone: data.timeZone || timeZone, rrule: data.recurrenceId ? null : data.rrule, exdates: data.recurrenceId ? [] : data.exdates,
      reminderMinutes: base.reminderMinutes ?? null, calendarId: calendar.id, source: base.source ?? client.provider,
      readOnly: !calendar.writable || Boolean(data.recurrenceId && !client.editableExceptions), recurrenceOf: parent?.event.id ?? base.recurrenceOf ?? null,
      recurrenceId: data.recurrenceId, cancelled: data.cancelled, createdAt: base.createdAt ?? stamp(), updatedAt: stamp(),
    })

    const replaceChildren = (parent: PlanningEvent, item: RemoteItem) => {
      if (client.editableExceptions) return
      for (const child of this.store.children(parent.id)) this.store.purgeEvent(child.event.id)
      for (const data of item.exceptions) {
        if (!data.recurrenceId) continue
        const at = stamp()
        this.store.saveEvent(calendar.profileId, toEvent(data, { recurrenceOf: parent.id }, null),
          { remoteId: `${item.remoteId}#${occurrenceKey(data.recurrenceId)}`, etag: item.etag, raw: null, remoteUpdated: item.updated, syncedAt: at })
      }
    }
    const applyRemote = (row: EventRow | null, item: RemoteItem) => {
      if (!item.master) return
      const parent = item.parentRemoteId ? byRemote.get(item.parentRemoteId) ?? null : null
      const event = toEvent(item.master, row?.event ?? {}, parent)
      const link = { remoteId: item.remoteId, etag: item.etag, raw: item.raw, remoteUpdated: item.updated, syncedAt: event.updatedAt }
      this.store.saveEvent(calendar.profileId, event, link)
      byRemote.set(item.remoteId, { event, link, deletedAt: null })
      replaceChildren(event, item)
    }
    const purge = (row: EventRow) => { for (const child of this.store.children(row.event.id)) this.store.purgeEvent(child.event.id); this.store.purgeEvent(row.event.id) }
    const pushUpdate = async (row: EventRow, etag: string, raw: string | null) => {
      try {
        const saved = await client.update(calendar.remoteId, row.link!.remoteId, etag, row.event, raw)
        this.store.setLink(row.event.id, { ...saved, remoteUpdated: saved.updated, syncedAt: stamp() })
        return true
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error
        // Changed again while we were writing: keep the remote version, the user sees the conflict.
        const fresh = await client.get(calendar.remoteId, row.link!.remoteId)
        if (fresh && !fresh.deleted) { applyRemote(row, fresh); conflict(row.event, 'remote', 'Событие изменилось в календаре во время отправки') }
        else purge(row)
        return false
      }
    }

    const reconcile = async (item: RemoteItem, row: EventRow | null) => {
      if (item.deleted) {
        if (!row) return
        if (row.deletedAt) { purge(row); return }
        if (row.link && row.event.updatedAt > row.link.syncedAt && !row.event.readOnly && !syntheticChild(row)) {
          this.store.setLink(row.event.id, null)
          conflict(row.event, 'local', 'Удалено в календаре, но изменено здесь — событие будет создано заново')
          return
        }
        purge(row)
        report.pulled.deleted++
        return
      }
      if (!row) {
        if (!item.master) return
        applyRemote(null, item)
        report.pulled.created++
        return
      }
      const link = row.link!
      const remoteChanged = item.etag !== link.etag
      const localChanged = row.event.updatedAt > link.syncedAt && !row.event.readOnly
      const remoteTime = item.updated ? Date.parse(item.updated) : 0
      if (row.deletedAt) {
        if (remoteChanged && remoteTime > Date.parse(row.deletedAt)) { applyRemote(row, item); conflict(row.event, 'remote', 'Удалено здесь, но позже изменено в календаре — событие восстановлено'); return }
        try { await client.remove(calendar.remoteId, link.remoteId, item.etag) } catch (error) { if (!(error instanceof PreconditionFailed)) throw error }
        purge(row)
        report.pushed.deleted++
        return
      }
      if (remoteChanged && localChanged) {
        if (remoteTime >= Date.parse(row.event.updatedAt)) { applyRemote(row, item); conflict(row.event, 'remote', 'Изменено в обоих местах — оставлена более поздняя версия из календаря') }
        else if (await pushUpdate(row, item.etag, item.raw)) conflict(row.event, 'local', 'Изменено в обоих местах — оставлена более поздняя версия отсюда')
        return
      }
      if (remoteChanged) { applyRemote(row, item); report.pulled.updated++; return }
      if (localChanged && await pushUpdate(row, link.etag, link.raw)) report.pushed.updated++
    }

    const step = async (work: () => Promise<void>, label: string) => {
      try { await work() } catch (error) {
        if (error instanceof AuthError) throw error
        report.errors.push(`${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'ошибка'}`)
      }
    }

    // An event created here carries the UID «<id>@ai-agents-hse». If the server stored it under another
    // address, the link moves to that address instead of deleting the event and importing a duplicate.
    const byOwnUid = new Map(rows.map((row) => [`${row.event.id}@ai-agents-hse`, row]))
    const seen = new Set<string>()
    const relink = (item: RemoteItem) => {
      const row = item.master && !item.parentRemoteId ? byOwnUid.get(item.master.uid) : undefined
      if (!row || row.link?.remoteId === item.remoteId) return null
      if (row.link) { seen.add(row.link.remoteId); byRemote.delete(row.link.remoteId) }
      const link = { remoteId: item.remoteId, etag: row.link?.etag ?? '', raw: row.link?.raw ?? null, remoteUpdated: row.link?.remoteUpdated ?? null, syncedAt: row.link?.syncedAt ?? row.event.updatedAt }
      this.store.setLink(row.event.id, link)
      const moved = { ...row, link }
      byRemote.set(item.remoteId, moved)
      return moved
    }

    // 1. Remote → local. Series first, so that separate occurrences find their parent.
    for (const item of [...items.filter((value) => !value.parentRemoteId), ...items.filter((value) => value.parentRemoteId)]) {
      seen.add(item.remoteId)
      await step(() => reconcile(item, byRemote.get(item.remoteId) ?? relink(item)), item.master?.title || 'событие')
    }
    // 2. Linked events outside the answer: moved out of the window or deleted.
    for (const row of rows) {
      if (!row.link || seen.has(row.link.remoteId) || syntheticChild(row)) continue
      const current = byRemote.get(row.link.remoteId)
      if (!current || current.event.id !== row.event.id) continue
      await step(async () => {
        const item = await client.get(calendar.remoteId, row.link!.remoteId)
        if (!item) await reconcile({ remoteId: row.link!.remoteId, etag: '', updated: null, deleted: true, master: null, exceptions: [], parentRemoteId: null, raw: null }, row)
        else if (item.deleted || item.etag !== row.link!.etag || row.deletedAt || row.event.updatedAt > row.link!.syncedAt) await reconcile(item, row)
      }, row.event.title)
    }
    // 3. Local → remote: new events and local deletions without a remote counterpart.
    for (const row of this.store.calendarRows(calendar.id)) {
      if (row.link || row.event.recurrenceOf) continue
      if (row.deletedAt) { this.store.purgeEvent(row.event.id); continue }
      if (!calendar.writable || row.event.readOnly) continue
      await step(async () => {
        const saved = await client.create(calendar.remoteId, row.event)
        this.store.setLink(row.event.id, { ...saved, remoteUpdated: saved.updated, syncedAt: stamp() })
        report.pushed.created++
      }, row.event.title)
    }
    return report
  }
}
