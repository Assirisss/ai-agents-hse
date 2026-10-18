import type { SendOptions } from '../telegram/bot.js'
import type { TelegramService } from '../telegram/service.js'
import { taskLine } from './agenda.js'
import type { PlanningService } from './service.js'
import { atLocalTime, formatMinutes, humanDate, localDate, localTime } from './time.js'

export type Notification = { key: string; text: string; options?: SendOptions }

const briefWindowMs = 3 * 3600000
const reminderGraceMs = 15 * 60000

/** Which messages are due right now. Pure calculation over stored data; tested without Telegram. */
export function dueNotifications(service: PlanningService, profileId: string, now: Date): Notification[] {
  const settings = service.store.settings(profileId)
  const timeZone = settings.timeZone
  const today = localDate(now, timeZone)
  const result: Notification[] = []

  if (settings.briefEnabled) {
    const at = atLocalTime(today, settings.briefTime, timeZone).getTime()
    // After a long downtime an old morning plan is not useful, so the window is limited.
    if (now.getTime() >= at && now.getTime() - at < briefWindowMs) result.push({ key: `brief:${profileId}:${today}`, text: service.brief(profileId, today).text })
  }

  const events = new Map(service.store.events(profileId).map((event) => [event.id, event]))
  for (const occurrence of service.occurrences(profileId, new Date(now.getTime() - reminderGraceMs), new Date(now.getTime() + 2 * 86400000))) {
    if (occurrence.allDay) continue
    const minutes = events.get(occurrence.eventId)?.reminderMinutes ?? settings.defaultReminderMinutes
    if (minutes < 0) continue
    const start = Date.parse(occurrence.start)
    const remindAt = start - minutes * 60000
    if (now.getTime() < remindAt || now.getTime() - remindAt > reminderGraceMs) continue
    const left = Math.round((start - now.getTime()) / 60000)
    const when = left > 0 ? `Через ${formatMinutes(left)}` : 'Сейчас'
    result.push({ key: `event:${occurrence.eventId}:${occurrence.start}`, text: `⏰ ${when}: ${localTime(new Date(occurrence.start), timeZone)}–${localTime(new Date(occurrence.end), timeZone)} ${occurrence.title}${occurrence.location ? `\n📍 ${occurrence.location}` : ''}` })
  }

  for (const task of service.store.tasks(profileId)) {
    if (task.status !== 'open' || !task.due || !task.dueHasTime) continue
    const minutes = task.reminderMinutes ?? settings.taskReminderMinutes
    if (minutes < 0) continue
    const due = Date.parse(task.due)
    const remindAt = due - minutes * 60000
    if (now.getTime() < remindAt || now.getTime() - remindAt > reminderGraceMs) continue
    const head = minutes === 0 ? '🔔 Напоминание' : `⏰ Срок через ${formatMinutes(Math.max(1, Math.round((due - now.getTime()) / 60000)))}`
    const date = localDate(new Date(task.due), timeZone)
    result.push({ key: `task:${task.id}:${task.due}`, text: `${head}: ${taskLine(task, timeZone)}${date === today ? '' : ` (${humanDate(date, false)})`}`, options: { buttons: [[{ text: '✓ Выполнено', callback_data: `pl:done:${task.id}` }]] } })
  }
  return result
}

/** Background loop: periodic synchronization and Telegram notifications. */
export class PlanningScheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  constructor(private service: PlanningService, private telegram: TelegramService | undefined, private intervalMs = 30000) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref()
    void this.tick()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  async tick(now = this.service.now()) {
    if (this.busy) return
    this.busy = true
    try {
      for (const profileId of this.service.store.profiles()) {
        await this.service.syncDue(profileId).catch(() => undefined)
        if (!this.telegram?.active) continue
        const chats = this.service.store.chats(profileId)
        if (!chats.length) continue
        for (const notification of dueNotifications(this.service, profileId, now)) {
          if (this.service.store.wasNotified(notification.key)) continue
          let delivered = 0
          for (const chat of chats) {
            try { await this.telegram.send(chat.chatId, notification.text, notification.options); delivered++ } catch { /* retried on the next tick while inside the window */ }
          }
          if (delivered) this.service.store.markNotified(profileId, notification.key)
        }
      }
    } finally { this.busy = false }
  }
}
