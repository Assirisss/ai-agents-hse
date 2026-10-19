import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Delivery, Draft, Payment, PaymentInput } from '../../../shared/finance.js'
import type { PlanningTask } from '../../../shared/planning.js'
import { taskInputSchema } from '../planning/schema.js'
import type { PlanningService } from '../planning/service.js'
import { atLocalTime, localDate, localTime } from '../planning/time.js'
import { TelegramError } from '../telegram/bot.js'
import { formatMoney } from './money.js'
import { dateSchema, FinanceError, moneySchema, moscowToday, profileSchema } from './schema.js'
import type { FinanceService } from './service.js'
import type { FinanceStore } from './store.js'
import { TelegramApiError } from './telegram.js'

const timeZone = 'Europe/Moscow'
const identifier = z.string().min(1).max(100).nullable().optional()
export const paymentInputSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название платежа').max(180),
  amount: moneySchema.nullable().default(null),
  dueDate: dateSchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ').default('09:00'),
  rrule: z.string().trim().max(300).nullable().default(null),
  accountId: identifier,
  categoryId: identifier,
}).strict()

const marker = (id: string) => `[finance-payment:${id}]`
const ownsTask = (task: PlanningTask, id: string) => task.notes.split('\n').includes(marker(id))

/** Financial obligations reuse planning tasks, while money is recorded only through an explicit draft confirmation. */
export class PaymentService {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private readonly now: () => Date

  constructor(
    private readonly store: FinanceStore,
    private readonly finance: FinanceService,
    private readonly planning?: PlanningService,
    private readonly options: { now?: () => Date; send?: (chatId: string, text: string) => Promise<unknown>; onError?: (message: string) => void } = {},
  ) { this.now = options.now ?? (() => new Date()) }

  async list(profileId: string): Promise<Payment[]> {
    const data = await this.store.read(profileSchema.parse(profileId))
    return data.payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt))
  }

  async create(profileId: string, raw: unknown): Promise<Payment> {
    profileSchema.parse(profileId)
    if (!this.planning) throw new FinanceError('Модуль планирования недоступен: напоминание не создано', 503)
    const input: PaymentInput = paymentInputSchema.parse(raw)
    // Reuse the calendar's actual rule validation before persisting anything.
    const validatedTask = this.taskInput(input, '')
    input.rrule = validatedTask.rrule
    const id = randomUUID(), at = this.now().toISOString()
    const payment: Payment = { ...input, id, planningTaskId: `fin-payment:${id}`, status: 'active', syncStatus: 'pending', createdAt: at, updatedAt: at }
    await this.store.transact(profileId, (data) => {
      if (input.accountId && !data.accounts.some((account) => account.id === input.accountId && !account.archived)) throw new FinanceError('Счёт не найден или архивирован', 404)
      if (input.categoryId && !data.categories.some((category) => category.id === input.categoryId && category.kind === 'expense')) throw new FinanceError('Категория расходов не найдена', 404)
      data.payments.push(payment)
    })
    await this.syncOne(profileId, payment.id)
    return this.get(profileId, id)
  }

  async cancel(profileId: string, id: string): Promise<Payment> {
    profileSchema.parse(profileId)
    await this.store.transact(profileId, (data) => {
      const payment = data.payments.find((item) => item.id === id)
      if (!payment) throw new FinanceError('Платёж не найден', 404)
      payment.status = 'cancelled'; payment.syncStatus = 'pending'; payment.updatedAt = this.now().toISOString()
    })
    await this.syncOne(profileId, id)
    return this.get(profileId, id)
  }

  async draft(profileId: string, id: string): Promise<Draft> {
    const payment = await this.get(profileSchema.parse(profileId), id)
    if (payment.status !== 'active') throw new FinanceError('Напоминание о платеже отменено', 409)
    const copied = { method: 'rule' as const, note: `Из напоминания «${payment.title}»; проверьте фактический платёж` }
    // Today's date represents the prospective actual payment, not its scheduled deadline.
    return this.finance.createDraft(profileId, {
      kind: 'expense', amount: payment.amount, date: moscowToday(this.now()),
      accountId: payment.accountId ?? null, categoryId: payment.categoryId ?? null, description: payment.title,
      provenance: {
        kind: { method: 'rule', note: 'Фактический платёж предлагается записать как расход после подтверждения' },
        date: { method: 'rule', note: 'Сегодня — предполагаемая дата фактической оплаты, не срок напоминания' },
        description: copied,
        ...(payment.amount !== null ? { amount: copied } : {}),
        ...(payment.accountId ? { accountId: copied } : {}),
        ...(payment.categoryId ? { categoryId: copied } : {}),
      },
    }, 'form')
  }

  private async get(profileId: string, id: string): Promise<Payment> {
    const payment = (await this.store.read(profileId)).payments.find((item) => item.id === id)
    if (!payment) throw new FinanceError('Платёж не найден', 404)
    return payment
  }

  private taskInput(input: PaymentInput, id: string) {
    const skipsShortMonths = /(?:^|;)FREQ=MONTHLY(?:;|$)/i.test(input.rrule ?? '')
      && (/(?:^|;)BYMONTHDAY=([^;]+)/i.exec(input.rrule ?? '')?.[1].split(',').some((day) => Number(day) > 28) ?? false)
    return taskInputSchema.parse({
      title: `Оплатить: ${input.title}`, project: 'Платежи',
      notes: `${marker(id)}\nФинансовое напоминание. Выполнение задачи не записывает расход. Подтвердите фактический платёж в разделе «Финансы».${skipsShortMonths ? '\nПовторение по числу месяца: месяцы без указанного дня пропускаются.' : ''}`,
      due: atLocalTime(input.dueDate, input.time, timeZone).toISOString(),
      timeZone,
      reminderMinutes: 0, rrule: input.rrule,
    })
  }

  /** Cross-store recovery is idempotent: finance is committed first, then a stable task id is upserted. */
  private async syncOne(profileId: string, id: string): Promise<void> {
    if (!this.planning) return
    try {
      const payment = await this.get(profileId, id)
      const matching = this.planning.store.tasks(profileId).filter((task) => ownsTask(task, id))
      if (payment.status === 'cancelled') {
        for (const task of matching) this.planning.store.deleteTask(profileId, task.id)
        await this.markSynced(profileId, id)
        return
      }
      let task = matching.filter((item) => item.status === 'open').sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))[0]
        ?? matching.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      if (!task) {
        const existing = this.planning.store.task(profileId, `fin-payment:${id}`)
        if (existing && !ownsTask(existing, id)) throw new FinanceError('Задача больше не принадлежит финансовому модулю', 409)
        const at = this.now().toISOString()
        task = this.planning.store.saveTask(profileId, {
          ...this.taskInput(payment, id), id: `fin-payment:${id}`, completedAt: null, source: 'manual', createdAt: at, updatedAt: at,
        })
      }
      // Pin older financial tasks as well; profile timezone changes must not shift Moscow payments.
      if (task.timeZone !== timeZone) task = this.planning.store.saveTask(profileId, { ...task, timeZone, updatedAt: this.now().toISOString() })
      const active = await this.store.transact(profileId, (data) => {
        const current = data.payments.find((item) => item.id === id)
        if (!current || current.status !== 'active') return false
        current.planningTaskId = task.id
        if (task.due) {
          current.dueDate = task.dueHasTime ? localDate(new Date(task.due), timeZone) : task.due
          if (task.dueHasTime) current.time = localTime(new Date(task.due), timeZone)
        }
        current.syncStatus = 'synced'; current.error = null
        return true
      })
      // Cancellation may race with a task insert in the other database. Compensate instead of reviving it.
      if (!active) for (const candidate of this.planning.store.tasks(profileId)) if (ownsTask(candidate, id)) this.planning.store.deleteTask(profileId, candidate.id)
    } catch {
      await this.store.transact(profileId, (data) => {
        const payment = data.payments.find((item) => item.id === id)
        if (payment) { payment.syncStatus = 'error'; payment.error = 'Не удалось синхронизировать напоминание с календарём. Повторим автоматически.' }
      })
      this.options.onError?.('Не удалось синхронизировать финансовое напоминание')
    }
  }

  private async markSynced(profileId: string, id: string) {
    await this.store.transact(profileId, (data) => {
      const payment = data.payments.find((item) => item.id === id)
      if (payment) { payment.syncStatus = 'synced'; payment.error = null }
    })
  }

  async sync(profileId?: string): Promise<void> {
    if (!this.planning) return
    for (const profile of profileId ? [profileSchema.parse(profileId)] : await this.store.profiles()) {
      const payments = (await this.store.read(profile)).payments
      for (const payment of payments) await this.syncOne(profile, payment.id)
    }
  }

  private async claim(profileId: string, paymentId: string, key: string, at: string): Promise<Delivery | null> {
    return this.store.transact(profileId, (data) => {
      if (!data.payments.some((item) => item.id === paymentId && item.status === 'active') || !data.telegram) return null
      let delivery = data.paymentDeliveries.find((item) => item.date === key)
      if (delivery) {
        if (delivery.status === 'sending' && Date.parse(at) - Date.parse(delivery.updatedAt) >= 120_000) {
          delivery.status = 'uncertain'; delivery.error = 'Отправка прервалась; автоматический повтор отключён'; delivery.updatedAt = at
          return null
        }
        if (delivery.status !== 'failed' || delivery.attempts >= 3 || Date.parse(at) - Date.parse(delivery.updatedAt) < 60_000) return null
        delivery.status = 'sending'; delivery.attempts++; delivery.updatedAt = at
      } else {
        delivery = { id: randomUUID(), date: key, status: 'sending', attempts: 1, updatedAt: at }
        data.paymentDeliveries.push(delivery)
      }
      return delivery
    })
  }

  private async finish(profileId: string, id: string, status: 'sent' | 'failed' | 'uncertain', error?: string) {
    await this.store.transact(profileId, (data) => {
      const delivery = data.paymentDeliveries.find((item) => item.id === id)
      if (delivery) Object.assign(delivery, { status, error: error ?? null, updatedAt: this.now().toISOString() })
    })
  }

  async tick(): Promise<void> {
    if (this.busy || !this.planning) return
    this.busy = true
    try {
      await this.sync()
      if (!this.options.send) return
      const now = this.now()
      for (const profileId of await this.store.profiles()) {
        const data = await this.store.read(profileId)
        if (!data.telegram) continue
        for (const payment of data.payments) {
          if (payment.status !== 'active' || payment.syncStatus !== 'synced') continue
          const task = this.planning.store.task(profileId, payment.planningTaskId)
          if (!task || !ownsTask(task, payment.id) || task.status !== 'open' || !task.due) continue
          const due = task.dueHasTime ? new Date(task.due) : atLocalTime(task.due, payment.time, timeZone)
          if (due.getTime() > now.getTime()) continue
          const key = `${payment.id}:${task.due}`
          const delivery = await this.claim(profileId, payment.id, key, now.toISOString())
          if (!delivery) continue
          const latest = await this.store.read(profileId)
          if (!latest.telegram || !latest.payments.some((item) => item.id === payment.id && item.status === 'active')) {
            await this.finish(profileId, delivery.id, 'failed', 'Напоминание отменено или Telegram отвязан')
            continue
          }
          const overdue = localDate(due, timeZone) < moscowToday(now) ? 'Просроченный платёж' : 'Напоминание о платеже'
          const text = `🔔 ${overdue}: ${payment.title}${payment.amount === null ? '' : ` — ${formatMoney(payment.amount)}`}\nСрок: ${localDate(due, timeZone)} в ${localTime(due, timeZone)} (Москва).\nОтметьте задачу в календаре после выполнения. Расход запишите и подтвердите отдельно в разделе «Финансы».`
          try {
            await this.options.send(latest.telegram.chatId, text)
          } catch (error) {
            const ambiguous = !(error instanceof TelegramApiError || error instanceof TelegramError) || error instanceof TelegramApiError && error.ambiguous
            await this.finish(profileId, delivery.id, ambiguous ? 'uncertain' : 'failed', ambiguous ? 'Telegram мог доставить напоминание; автоматический повтор отключён' : 'Telegram отклонил напоминание')
            continue
          }
          await this.finish(profileId, delivery.id, 'sent')
        }
      }
    } catch { this.options.onError?.('Не удалось проверить финансовые напоминания') }
    finally { this.busy = false }
  }

  start(intervalMs = 30_000): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), Math.min(Math.max(intervalMs, 1000), 60_000))
      this.timer.unref()
      void this.tick()
    }
    return () => this.stop()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
}
