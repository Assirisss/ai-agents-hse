import type { Delivery, Instrument, MarketSummary } from '../../../shared/finance.js'
import { moscowDate } from './market.js'
import { TelegramApiError } from './telegram.js'

/** claimDelivery and finishDelivery must be persisted atomically by the store.
 * A claim creates today's sending record, or retries a failed record after 60s,
 * with at most 3 attempts. Sending records older than 2 minutes become uncertain.
 * Sent/uncertain records are never claimed automatically.
 */
export interface FinanceWorkerPort {
  profiles(): Promise<{ profileId: string; chatId: string; watchlist: Instrument[] }[]>
  claimDelivery(profileId: string, date: string, now: string): Promise<Delivery | null>
  summary(profileId: string): Promise<MarketSummary>
  finishDelivery(profileId: string, deliveryId: string, status: 'sent' | 'failed' | 'uncertain', error?: string): Promise<void>
}

export class FinanceWorker {
  private busy = false
  private readonly now: () => Date
  private readonly onError: (message: string) => void

  constructor(private readonly port: FinanceWorkerPort, private readonly send: (chatId: string, text: string) => Promise<unknown>, options: { now?: () => Date; onError?: (message: string) => void } = {}) {
    this.now = options.now ?? (() => new Date())
    this.onError = options.onError ?? (() => undefined)
  }

  async tick(): Promise<void> {
    if (this.busy) return
    const current = this.now()
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(current))
    if (hour < 21) return
    this.busy = true
    try {
      const date = moscowDate(current)
      for (const profile of await this.port.profiles()) {
        if (!profile.chatId || !profile.watchlist.length) continue
        const delivery = await this.port.claimDelivery(profile.profileId, date, current.toISOString())
        if (!delivery) continue
        let summary: MarketSummary
        try { summary = await this.port.summary(profile.profileId) }
        catch { await this.port.finishDelivery(profile.profileId, delivery.id, 'failed', 'Не удалось подготовить сводку'); continue }
        const latest = (await this.port.profiles()).find(item => item.profileId === profile.profileId)
        if (!latest || latest.chatId !== profile.chatId || !latest.watchlist.length) {
          await this.port.finishDelivery(profile.profileId, delivery.id, 'failed', 'Telegram отключён, привязка изменилась или список наблюдения очищен')
          continue
        }
        try { await this.send(profile.chatId, summary.text) }
        catch (error) {
          const uncertain = !(error instanceof TelegramApiError) || error.ambiguous
          await this.port.finishDelivery(profile.profileId, delivery.id, uncertain ? 'uncertain' : 'failed', uncertain ? 'Telegram мог доставить сводку; автоматический повтор отключён' : 'Telegram отклонил отправку')
          continue
        }
        await this.port.finishDelivery(profile.profileId, delivery.id, 'sent')
      }
    } catch { this.onError('Финансовый worker не смог завершить проверку заданий') }
    finally { this.busy = false }
  }

  start(intervalMs = 30_000): () => void {
    void this.tick()
    const timer = setInterval(() => { void this.tick() }, Math.min(Math.max(intervalMs, 1000), 60_000))
    timer.unref()
    return () => clearInterval(timer)
  }
}
