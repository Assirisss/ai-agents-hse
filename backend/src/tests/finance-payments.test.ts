import assert from 'node:assert/strict'
import test from 'node:test'
import type { FinanceSnapshot } from '../../../shared/finance.js'
import { PaymentService } from '../finance/payments.js'
import { FinanceError } from '../finance/schema.js'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore } from '../finance/store.js'
import { TelegramApiError } from '../finance/telegram.js'
import { dueNotifications } from '../planning/scheduler.js'
import { SecretBox } from '../planning/secrets.js'
import { PlanningService } from '../planning/service.js'
import { PlanningStore } from '../planning/store.js'
import { TelegramError } from '../telegram/bot.js'

function fixture(options: { send?: (chatId: string, text: string) => Promise<unknown>; store?: MemoryFinanceStore } = {}) {
  let current = new Date('2026-10-19T06:00:00.000Z')
  const now = () => current
  const store = options.store ?? new MemoryFinanceStore()
  const finance = new FinanceService(store, undefined, undefined, { now })
  const planning = new PlanningService(new PlanningStore(':memory:', SecretBox.ephemeral(), now), undefined, { clock: now })
  planning.saveSettings('owner', { briefEnabled: false })
  const sent: { chatId: string; text: string }[] = []
  const send = options.send ?? (async (chatId: string, text: string) => { sent.push({ chatId, text }) })
  const payments = new PaymentService(store, finance, planning, { now, send })
  const link = () => store.transact('owner', (data) => { data.telegram = { chatId: '7', userId: '7', linkedAt: now().toISOString() } })
  return { payments, store, finance, planning, now, sent, link, setNow: (date: string) => { current = new Date(date) }, close: () => planning.close() }
}

test('payment validates before persisting; optional amount and 09:00 Moscow use a shared planning task', async (t) => {
  const f = fixture(); t.after(f.close)
  await assert.rejects(f.payments.create('owner', { title: 'Счёт', dueDate: '2026-02-30' }))
  await assert.rejects(f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-25', rrule: 'nonsense' }))
  await assert.rejects(f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-25', accountId: 'other-profile' }), /Счёт/)
  await assert.rejects(f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-25', categoryId: 'salary' }), /Категория расходов/)
  assert.equal((await f.payments.list('owner')).length, 0)
  const payment = await f.payments.create('owner', { title: 'Коммунальные услуги', dueDate: '2026-10-25' })
  assert.equal(payment.amount, null)
  assert.equal(payment.time, '09:00')
  assert.equal(payment.syncStatus, 'synced')
  const task = f.planning.task('owner', payment.planningTaskId)
  assert.equal(task.id, `fin-payment:${payment.id}`)
  assert.equal(task.due, '2026-10-25T06:00:00.000Z')
  assert.equal(task.reminderMinutes, 0)
  await f.payments.sync('owner'); await f.payments.sync('owner')
  assert.equal(f.planning.store.tasks('owner').length, 1)
  assert.equal((await f.finance.state('owner')).operations.length, 0)
})

test('missing planning service returns 503 without creating a phantom obligation', async () => {
  const store = new MemoryFinanceStore()
  const payments = new PaymentService(store, new FinanceService(store))
  await assert.rejects(payments.create('owner', { title: 'Аренда', dueDate: '2026-10-25' }), (error) => error instanceof FinanceError && error.statusCode === 503)
  assert.equal((await payments.list('owner')).length, 0)
})

test('completing a recurring task advances the reminder without creating an expense', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Аренда', amount: 50_000_00, dueDate: '2026-10-25', rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', accountId: 'cash', categoryId: 'home' })
  const { next } = f.planning.completeTask('owner', payment.planningTaskId)
  assert.ok(next)
  await f.payments.sync('owner')
  const [updated] = await f.payments.list('owner')
  assert.equal(updated!.planningTaskId, next.id)
  assert.equal(updated!.dueDate, '2026-11-25')
  assert.equal((await f.finance.state('owner')).operations.length, 0)
  const draft = await f.payments.draft('owner', payment.id)
  assert.equal(draft.kind, 'expense')
  assert.equal(draft.amount, 50_000_00)
  assert.equal(draft.date, '2026-10-19', 'actual payment defaults to today instead of its future deadline')
  assert.equal(draft.provenance?.amount?.method, 'rule')
  assert.equal(draft.provenance?.accountId?.method, 'rule')
  assert.equal(draft.provenance?.categoryId?.method, 'rule')
  assert.match(draft.provenance?.amount?.note ?? '', /Из напоминания/)
  assert.match(draft.provenance?.date?.note ?? '', /не срок напоминания/)
  assert.equal(draft.status, 'pending')
  assert.equal(draft.missing.length, 0)
  assert.equal((await f.finance.state('owner')).operations.length, 0)
})

test('payment draft preserves missing account/category/amount for explicit clarification', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Подписка', dueDate: '2026-10-25' })
  const draft = await f.payments.draft('owner', payment.id)
  assert.ok(draft.missing.includes('Сумма'))
  assert.ok(draft.missing.includes('Счёт'))
  assert.ok(draft.missing.includes('Категория'))
  assert.equal((await f.finance.state('owner')).operations.length, 0)
})

test('cancellation removes its recurring tasks within the profile and preserves unrelated tasks', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Аренда', dueDate: '2026-10-25', rrule: 'FREQ=MONTHLY;BYMONTHDAY=25' })
  f.planning.completeTask('owner', payment.planningTaskId)
  const ordinary = f.planning.createTask('owner', { title: 'Своя задача', due: '2026-10-25' })
  const foreign = f.planning.createTask('someone', { title: 'Платёж другого профиля', notes: `[finance-payment:${payment.id}]`, due: '2026-10-25' })
  await assert.rejects(f.payments.cancel('someone', payment.id), /не найден/)
  const cancelled = await f.payments.cancel('owner', payment.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.syncStatus, 'synced')
  assert.deepEqual(f.planning.store.tasks('owner').map((task) => task.id), [ordinary.id])
  assert.equal(f.planning.task('someone', foreign.id).id, foreign.id)
  await assert.rejects(f.payments.draft('owner', payment.id), /отменено/)
  await f.payments.sync('owner')
  assert.equal(f.planning.store.tasks('owner').length, 1)
})

test('financial catch-up survives downtime, stays separate from planning notifications and sends once per due date', async (t) => {
  const f = fixture(); t.after(f.close)
  await f.link()
  const payment = await f.payments.create('owner', { title: 'Страховка', amount: 500_00, dueDate: '2026-10-19', rrule: 'FREQ=MONTHLY;BYMONTHDAY=19' })
  assert.equal(dueNotifications(f.planning, 'owner', f.now()).filter((item) => item.key.startsWith('task:')).length, 0)
  f.setNow('2026-10-22T08:00:00Z')
  await f.payments.tick()
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0]!.text, /Просроченный платёж/)
  assert.match(f.sent[0]!.text, /500,00 ₽/)
  assert.match(f.sent[0]!.text, /Расход запишите и подтвердите отдельно/)
  const restarted = new PaymentService(f.store, f.finance, f.planning, { now: f.now, send: async () => { throw new Error('must not send again') } })
  await restarted.tick()
  assert.equal((await f.store.read('owner')).paymentDeliveries.length, 1)
  f.planning.completeTask('owner', payment.planningTaskId)
  f.setNow('2026-11-19T06:00:00Z')
  await f.payments.tick()
  assert.equal(f.sent.length, 2)
  assert.equal((await f.store.read('owner')).paymentDeliveries.length, 2)
  assert.equal((await f.finance.state('owner')).operations.length, 0)
})

test('payment reminders wait for the exact deadline, ignore completed tasks and require the finance binding', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Аренда', dueDate: '2026-10-19', time: '10:00' })
  await f.payments.tick(); assert.equal(f.sent.length, 0)
  await f.link()
  await f.payments.tick(); assert.equal(f.sent.length, 0)
  f.planning.completeTask('owner', payment.planningTaskId)
  await f.payments.sync('owner')
  assert.equal((await f.payments.list('owner'))[0]!.status, 'active', 'task completion does not claim that money has been paid')
  assert.equal((await f.payments.draft('owner', payment.id)).status, 'pending', 'an actual expense can still be recorded after marking its reminder done')
  f.setNow('2026-10-19T07:00:00Z')
  await f.payments.tick(); assert.equal(f.sent.length, 0)
  await f.payments.create('owner', { title: 'Второй платёж', dueDate: '2026-10-19', time: '10:00' })
  await f.payments.tick(); assert.equal(f.sent.length, 1)
})

test('a monthly reminder on the 31st explains why months without that day are skipped', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Подписка', dueDate: '2026-10-31', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' })
  const task = f.planning.task('owner', payment.planningTaskId)
  assert.match(task.notes, /месяцы без указанного дня пропускаются/)
  const { next } = f.planning.completeTask('owner', task.id)
  assert.equal(next?.due, '2026-12-31T06:00:00.000Z')
})

test('definitive Telegram failures retry at most three times, while ambiguous failures are never retried', async (t) => {
  let attempts = 0
  const f = fixture({ send: async () => { attempts++; throw new TelegramError('Rejected', 429) } }); t.after(f.close)
  await f.link(); await f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-19' })
  await f.payments.tick(); await f.payments.tick()
  assert.equal(attempts, 1, 'wait at least a minute before retry')
  f.setNow('2026-10-19T06:01:01Z'); await f.payments.tick()
  f.setNow('2026-10-19T06:02:02Z'); await f.payments.tick()
  f.setNow('2026-10-19T06:03:03Z'); await f.payments.tick()
  assert.equal(attempts, 3)
  assert.equal((await f.store.read('owner')).paymentDeliveries[0]!.status, 'failed')
  for (const failure of [new TelegramApiError('timeout', true, true), new Error('unknown transport failure')]) {
    let uncertainAttempts = 0
    const u = fixture({ send: async () => { uncertainAttempts++; throw failure } }); t.after(u.close)
    await u.link(); await u.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-19' })
    await u.payments.tick(); u.setNow('2026-10-19T06:05:00Z'); await u.payments.tick()
    assert.equal(uncertainAttempts, 1)
    assert.equal((await u.store.read('owner')).paymentDeliveries[0]!.status, 'uncertain')
  }
})

test('an interrupted send is made uncertain after restart instead of being duplicated', async (t) => {
  const f = fixture(); t.after(f.close)
  await f.link()
  const payment = await f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-19' })
  const task = f.planning.task('owner', payment.planningTaskId)
  await f.store.transact('owner', (data) => {
    data.paymentDeliveries.push({ id: 'interrupted', date: `${payment.id}:${task.due}`, status: 'sending', attempts: 1, updatedAt: '2026-10-19T05:57:00Z' })
  })
  await f.payments.tick()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.store.read('owner')).paymentDeliveries[0]!.status, 'uncertain')
})

test('sync and cancellation preserve a task whose financial ownership marker was removed', async (t) => {
  const f = fixture(); t.after(f.close)
  const payment = await f.payments.create('owner', { title: 'Счёт', dueDate: '2026-10-25' })
  f.planning.updateTask('owner', payment.planningTaskId, { title: 'Теперь обычная задача', notes: 'Личные заметки' })
  await f.payments.sync('owner')
  assert.equal((await f.payments.list('owner'))[0]!.syncStatus, 'error')
  assert.equal(f.planning.task('owner', payment.planningTaskId).notes, 'Личные заметки')
  await f.payments.cancel('owner', payment.id)
  assert.equal(f.planning.task('owner', payment.planningTaskId).title, 'Теперь обычная задача')
})

test('a failed finance acknowledgement after task insertion recovers without duplicating the calendar task', async (t) => {
  class FailingStore extends MemoryFinanceStore {
    failNextAck = false
    override async transact<T>(profileId: string, action: (data: FinanceSnapshot) => T | Promise<T>): Promise<T> {
      return super.transact(profileId, async (data) => {
        const result = await action(data)
        if (this.failNextAck && data.payments.some((payment) => payment.syncStatus === 'synced')) {
          this.failNextAck = false
          throw new Error('simulated finance commit failure')
        }
        return result
      })
    }
  }
  const store = new FailingStore(), f = fixture({ store }); t.after(f.close)
  store.failNextAck = true
  const payment = await f.payments.create('owner', { title: 'Налог', dueDate: '2026-10-25' })
  assert.equal(payment.syncStatus, 'error')
  assert.equal(f.planning.store.tasks('owner').length, 1)
  await f.payments.sync('owner')
  assert.equal((await f.payments.list('owner'))[0]!.syncStatus, 'synced')
  assert.equal(f.planning.store.tasks('owner').length, 1)
})
