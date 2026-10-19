import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { demoQuestions, seedFinanceDemo } from '../finance/demo.js'
import { analysisIntent } from '../finance/analysis-intent.js'
import { FinanceChatService } from '../finance/chat.js'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore } from '../finance/store.js'
import { PlanningService } from '../planning/service.js'
import { PlanningStore } from '../planning/store.js'
import { SecretBox } from '../planning/secrets.js'

test('subscription and unusual-purchase descriptions create drafts; analytical questions stay read-only', async () => {
  const finance = new FinanceService(new MemoryFinanceStore())
  const chat = new FinanceChatService(finance, undefined, () => new Date('2026-10-19T10:00:00Z'))
  for (const text of ['Сегодня потратил 300 рублей на подписку, счёт Наличные', 'Оплатил подписку 300 рублей сегодня со счёта Наличные', 'Купил необычный подарок за 300 рублей сегодня, счёт Наличные', 'Расход 300 подписка; счёт Наличные; дата сегодня']) {
    const conversation = await chat.create('review')
    const result = await chat.send('review', conversation.id, { turnId: randomUUID(), expectedRevision: 0, text })
    const reply = result.conversation.messages.find(item => item.id === result.messageId)!.reply!
    assert.equal(reply.analysis, undefined)
    assert.equal(reply.draft?.amount, 30000)
    assert.equal(reply.draft?.status, 'pending')
  }
  assert.equal(analysisIntent('Почему я потратил 300 рублей на подписку?'), 'recurring')
  assert.equal(analysisIntent('Найди регулярные расходы за 2026-10-01 2026-10-19'), 'recurring')
  assert.equal(analysisIntent('Что будет, если сократить расходы на подписку на 20%?'), 'scenario')
  assert.equal(analysisIntent('описание Подписка на музыку'), undefined)
  assert.equal((await finance.state('review')).operations.length, 0)
})

for (const date of ['2026-10-19T10:00:00Z', '2026-03-01T10:00:00Z']) {
  test(`demo seed supports all analyses on ${date.slice(0, 10)} and preserves personal data`, async () => {
    const now = () => new Date(date), store = new MemoryFinanceStore()
    const planning = new PlanningService(new PlanningStore(':memory:', SecretBox.ephemeral(), now), undefined, { clock: now })
    try {
      const finance = new FinanceService(store, undefined, undefined, { now })
      await finance.createDraft('default', { description: 'Личный черновик' })
      const before = await store.read('default')
      const personalTask = planning.createTask('default', { title: 'Личная задача', due: '2026-11-01' })
      const unrelated = planning.createTask('demo', { title: 'Чужая демозадача', due: '2026-11-01' })
      const first = await seedFinanceDemo(store, planning, now())
      assert.ok(first.operations >= 30)
      assert.equal(first.reports, demoQuestions.length)
      const state = await finance.state('demo')
      assert.equal(state.watchlist.length, 2)
      assert.equal(state.telegram, null)
      assert.equal(state.drafts.filter(item => item.status === 'pending').length, 1)
      assert.deepEqual(await store.read('default'), before)
      assert.equal(planning.task('default', personalTask.id).title, 'Личная задача')
      const reports = (await store.read('demo')).conversations.map(item => item.messages.at(-1)!.reply!)
      assert.ok(reports.every(item => item.method === 'rules'))
      assert.ok(reports.every(item => item.analysis?.facts.length))
      assert.ok(reports.find(item => item.analysis?.kind === 'changes')!.analysis!.facts.some(item => /вклад в изменение/.test(item.text)))
      assert.ok(reports.find(item => item.analysis?.kind === 'unusual')!.analysis!.facts.some(item => /Необычно крупная/.test(item.text)))
      assert.ok(reports.find(item => item.analysis?.kind === 'unusual')!.analysis!.facts.some(item => /Возможный дубликат/.test(item.text)))
      assert.ok(reports.find(item => item.analysis?.kind === 'recurring')!.analysis!.facts.filter(item => item.type === 'hypothesis').length >= 2)
      assert.ok(reports.find(item => item.analysis?.kind === 'weekly')!.analysis!.facts.some(item => /Ближайшие сохранённые напоминания/.test(item.text)))
      for (const report of reports) for (const link of report.evidence || []) for (const id of link.operationIds) assert.ok(state.operations.some(item => item.id === id))
      assert.equal(planning.tasks('demo').filter(item => item.notes.includes('[finance-payment:')).length, 2)
      assert.ok((await store.read('demo')).payments.every(item => item.syncStatus === 'synced'))

      const oldIds = new Set(planning.tasks('demo').filter(item => item.id !== unrelated.id).map(item => item.id))
      const repeated = await seedFinanceDemo(store, planning, now())
      assert.equal(repeated.operations, first.operations)
      assert.equal(planning.tasks('demo').length, 3)
      assert.ok(planning.tasks('demo').every(item => !oldIds.has(item.id)))
      assert.deepEqual(await store.read('default'), before)
    } finally { planning.close() }
  })
}

test('demo reset refuses to remove an existing Telegram binding', async () => {
  const store = new MemoryFinanceStore()
  await store.transact('demo', data => { data.telegram = { chatId: '7', userId: '7', linkedAt: '2026-10-19T10:00:00Z' } })
  const before = await store.read('demo')
  await assert.rejects(seedFinanceDemo(store, undefined, new Date('2026-10-19T10:00:00Z')), /Демопрофиль привязан/)
  assert.deepEqual(await store.read('demo'), before)
})
