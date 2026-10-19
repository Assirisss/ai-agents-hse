import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { DraftInput } from '../../../shared/finance.js'
import { PlanningService } from '../planning/service.js'
import { PlanningStore } from '../planning/store.js'
import { SecretBox } from '../planning/secrets.js'
import { FinanceChatService } from './chat.js'
import { shiftDate } from './analysis.js'
import { PaymentService } from './payments.js'
import { FinanceError, moscowToday } from './schema.js'
import { FinanceService } from './service.js'
import { MemoryFinanceStore, type FinanceStore } from './store.js'

export const DEMO_PROFILE = 'demo'
export const demoQuestions = [
  'Почему в этом месяце потратил больше?',
  'Есть ли необычные расходы?',
  'Найди мои регулярные платежи',
  'Что будет, если сократить продукты на 20%?',
  'Как прошла моя финансовая неделя?',
]

/** Build everything privately, then replace only the dedicated demo profile in one transaction. */
export async function seedFinanceDemo(store: FinanceStore, planning?: PlanningService, now = new Date()) {
  const clock = () => now, today = moscowToday(now), first = `${today.slice(0, 7)}-01`
  const month = (offset: number) => new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + offset, 1)).toISOString().slice(0, 7)
  const day = Math.min(5, Number(today.slice(8)))
  const monthlyDate = (offset: number) => `${month(offset)}-${String(day).padStart(2, '0')}`
  const memory = new MemoryFinanceStore(), finance = new FinanceService(memory, undefined, undefined, { now: clock })
  const calendar = new PlanningService(new PlanningStore(':memory:', SecretBox.ephemeral(), clock), undefined, { clock })
  try {
    const card = await finance.createAccount(DEMO_PROFILE, { name: 'Карта', initialBalance: 3_000_000 })
    const subscriptions = await finance.createCategory(DEMO_PROFILE, { name: 'Подписки', kind: 'expense' })
    const shopping = await finance.createCategory(DEMO_PROFILE, { name: 'Покупки', kind: 'expense' })
    const delivery = await finance.createCategory(DEMO_PROFILE, { name: 'Доставка', kind: 'expense' })
    const post = async (input: DraftInput) => {
      const draft = await finance.createDraft(DEMO_PROFILE, { accountId: card.id, ...input })
      await finance.confirmDraft(DEMO_PROFILE, draft.id, draft.revision ?? 0)
    }
    for (const offset of [-2, -1, 0]) {
      const date = monthlyDate(offset)
      await post({ kind: 'income', amount: 12_000_000, date, categoryId: 'salary', description: 'Зарплата (демо)' })
      await post({ kind: 'expense', amount: 3_500_000, date, categoryId: 'home', description: 'Аренда квартиры (демо)' })
      await post({ kind: 'expense', amount: 19_900, date, categoryId: subscriptions.id, description: 'Музыкальный сервис (демо)' })
    }
    // At least five prior purchases on distinct dates establish an inspectable anomaly baseline.
    for (let index = 0; index < 12; index++) await post({
      kind: 'expense', amount: 55_000 + index % 3 * 5_000, date: shiftDate(first, -90 + index * 7),
      categoryId: 'food', description: `Обычные продукты — покупка ${index + 1} (демо)`,
    })
    for (let index = 0; index < 5; index++) {
      const date = `${today.slice(0, 7)}-${String(1 + Math.floor(index * (Number(today.slice(8)) - 1) / 4)).padStart(2, '0')}`
      await post({ kind: 'expense', amount: 100_000 + index * 25_000, date, categoryId: 'food', description: `Продукты — покупка ${index + 1} (демо)` })
      await post({ kind: 'expense', amount: 80_000, date, categoryId: delivery.id, description: 'Доставка еды (демо)' })
    }
    await post({ kind: 'expense', amount: 950_000, date: today, categoryId: 'food', description: 'Большая закупка продуктов (демо)' })
    await post({ kind: 'expense', amount: 3_000_000, date: today, categoryId: shopping.id, description: 'Покупка монитора (демо)' })
    for (let index = 0; index < 2; index++) await post({ kind: 'expense', amount: 29_900, date: today, categoryId: 'transport', description: 'Такси — проверить совпадение (демо)' })
    await post({ kind: 'income', amount: 500_000, date: shiftDate(today, -2), categoryId: 'other-income', description: 'Подработка (демо)' })
    await post({ kind: 'transfer', amount: 1_000_000, date: today, destinationAccountId: 'cash', description: 'Снятие наличных (демо)' })
    await finance.createDraft(DEMO_PROFILE, { kind: 'expense', amount: 35_000, date: today, accountId: 'cash', categoryId: 'food', description: 'Кофе: проверьте и подтвердите (демо)' })

    const payments = new PaymentService(memory, finance, calendar, { now: clock })
    await payments.create(DEMO_PROFILE, { title: 'Интернет (демо)', dueDate: shiftDate(today, 2), time: '09:00', amount: 120_000, accountId: card.id, categoryId: 'home' })
    const rentDate = shiftDate(today, 5)
    await payments.create(DEMO_PROFILE, { title: 'Аренда (демо)', dueDate: rentDate, time: '09:00', amount: 3_500_000, rrule: `FREQ=MONTHLY;BYMONTHDAY=${Number(rentDate.slice(8))}`, accountId: card.id, categoryId: 'home' })

    // These saved reports deliberately use deterministic tools; new chat requests use configured models.
    const chat = new FinanceChatService(finance, undefined, clock)
    for (const text of demoQuestions) {
      const conversation = await chat.create(DEMO_PROFILE)
      await chat.send(DEMO_PROFILE, conversation.id, { turnId: randomUUID(), expectedRevision: 0, text })
    }
    const snapshot = await memory.read(DEMO_PROFILE)
    snapshot.watchlist = [{ ticker: 'SBER', name: 'Сбербанк' }, { ticker: 'GAZP', name: 'Газпром' }]
    for (const payment of snapshot.payments) payment.syncStatus = 'pending'
    const oldPaymentIds = await store.transact(DEMO_PROFILE, current => {
      if (current.telegram) throw new FinanceError('Демопрофиль привязан к Telegram. Отключите его перед сбросом демоданных.', 409)
      const ids = current.payments.map(item => item.id)
      Object.assign(current, snapshot)
      return ids
    })
    if (planning) {
      for (const task of planning.store.tasks(DEMO_PROFILE)) {
        if (oldPaymentIds.some(id => task.notes.split('\n').includes(`[finance-payment:${id}]`))) planning.store.deleteTask(DEMO_PROFILE, task.id)
      }
      await new PaymentService(store, new FinanceService(store), planning).sync(DEMO_PROFILE)
    }
    return { profileId: DEMO_PROFILE, asOf: today, operations: snapshot.operations.length, reports: snapshot.conversations.length, payments: snapshot.payments.length, watchlist: snapshot.watchlist.length }
  } finally { calendar.close(); await memory.close() }
}

/** Clearly synthetic receipt for a repeatable vision demonstration, without personal details. */
export async function createDemoReceipt(now = new Date()): Promise<Buffer> {
  const date = moscowToday(now).split('-').reverse().join('.')
  const lines = ['ДЕМО · НЕ ФИСКАЛЬНЫЙ ЧЕК', 'Магазин «Демомаркет»', `Дата: ${date}`, 'Молоко — 1 × 100,00 = 100,00 RUB', 'Хлеб — 1 × 80,50 = 80,50 RUB', 'Кофе — 1 × 1070,00 = 1070,00 RUB', 'ИТОГО К ОПЛАТЕ: 1250,50 RUB', 'Вымышленные данные для тестирования']
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="sans-serif" font-size="32">${lines.map((line, index) => `<text x="35" y="${65 + index * 75}">${line}</text>`).join('')}</g></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
