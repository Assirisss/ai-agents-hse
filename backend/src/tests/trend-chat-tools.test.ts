import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { TrendResearchService } from '../trends/service.js'
import { createTrendChatTools, filterSources, compareReports, allowsResearch } from '../trends/chat-tools.js'
import { evaluationPage, evaluationReport } from '../evals/fixtures.js'
import type { TrendChatToolContext } from '../../../shared/trend-chat.js'

function setup() {
  const service = new TrendResearchService()
  const conversation = service.memory.chats.create('alice')
  const report = { ...evaluationReport(), id: randomUUID(), webResults: [evaluationPage('first'), evaluationPage('old', { publishedAt: '2025-01-01T00:00:00Z' }), evaluationPage('unknown', { publishedAt: null, read: false, text: undefined })] }
  service.memory.saveReport('alice', report)
  conversation.activeReportId = report.id
  const context: TrendChatToolContext = { conversation, request: { turnId: randomUUID(), expectedRevision: 0, text: 'Покажи источники', mode: 'live', enableAi: false, useWeb: false, useModuleContext: false }, reports: new Map([[report.id, report]]), bookmarks: [], reportIds: new Set(), newReports: [] }
  return { service, context, report, tools: createTrendChatTools(context, service) }
}

void test('source filters distinguish dated, recent, read and metadata, with stable ordering and limits', () => {
  const { service, report } = setup()
  try {
    assert.deepEqual(filterSources(report, { onlyRecent: true }).map((item) => item.id), ['first'])
    assert.equal(filterSources(report, { onlyDated: true }).length, 2)
    assert.equal(filterSources(report, { onlyRead: true }).length, 2)
    assert.equal(filterSources(report, { query: 'require verifiable', limit: 1 }).length, 1)
    assert.equal(filterSources(report, { publisher: 'first' })[0].id, 'first')
    assert.throws(() => filterSources(report, { limit: 500 }))
  } finally { service.close() }
})

void test('comparisons normalize URLs and refuse to mix demo/live or unrelated topics', () => {
  const { service, report } = setup()
  try {
    const other = { ...report, id: randomUUID(), webResults: [evaluationPage('first', { url: 'https://first.example.org/article?utm_source=test' }), evaluationPage('new')] }
    const result = compareReports(report, other)
    assert.deepEqual(result.added.map((item) => item.id), ['new'])
    assert.equal(result.repeated.length, 1)
    assert.equal(result.missing.length, 2)
    assert.equal(compareReports(report, { ...other, request: { ...other.request, mode: 'demo' } }).comparable, false)
    assert.equal(compareReports(report, { ...other, request: { ...other.request, query: 'unrelated' } }).comparable, false)
    assert.ok(result.notes.some((note) => note.includes('не доказывает рост')))
  } finally { service.close() }
})

void test('brief updates are validated and cannot turn private profile facts into a search query', async () => {
  const { service, context, tools } = setup()
  try {
    service.memory.saveProfile('alice', { goals: ['private financial goal'] })
    await tools.execute('update_brief', { windowDays: 14 })
    assert.equal(context.conversation.brief.windowDays, 14)
    await assert.rejects(tools.execute('update_brief', { windowDays: 31 }))
    await assert.rejects(tools.execute('update_brief', { query: 'private financial goal' }), /текущего сообщения/)
    context.request.text = 'Тема: AI agents'
    await tools.execute('update_brief', { query: 'AI agents' })
    assert.equal(context.conversation.brief.query, 'AI agents')
    assert.equal(context.newReports.length, 0)
    await assert.rejects(tools.execute('read_file', { path: '.env' }), /Неизвестный инструмент/)
  } finally { service.close() }
})

void test('source inspection never claims metadata as full text and cannot cross profiles', async () => {
  const { service, tools } = setup()
  try {
    const source = await tools.execute('inspect_source', { sourceId: 'unknown' }) as { level: string; note: string }
    assert.equal(source.level, 'metadata')
    assert.match(source.note, /не доказывают/)
    const privateReport = { ...evaluationReport(), id: randomUUID() }
    service.memory.saveReport('bob', privateReport)
    await assert.rejects(tools.execute('filter_sources', { reportId: privateReport.id }), /не найден/)
    await assert.rejects(tools.execute('inspect_source', { sourceId: 'http://127.0.0.1' }), /не найден/)
  } finally { service.close() }
})

void test('research accepts topic requests, has a one-run limit and never nests model calls', async () => {
  const { service, context, tools } = setup()
  try {
    context.conversation.brief.query = 'AI agents'
    await assert.rejects(tools.execute('research_now', {}), /Поиск отключён/)
    context.request.text = 'Найди AI agents'; context.request.mode = 'demo'
    await tools.execute('research_now', {})
    assert.equal(context.newReports.length, 1)
    assert.equal(context.newReports[0].request.enableAi, false)
    assert.equal(context.newReports[0].request.remember, false)
    assert.equal(service.memory.report('alice', context.newReports[0].id), null)
    await assert.rejects(tools.execute('research_now', {}), /одно исследование/)
  } finally { service.close() }
})

void test('bookmarks need an explicit request, are staged and deduplicated atomically with a chat turn', async () => {
  const { service, context, tools } = setup()
  try {
    await assert.rejects(tools.execute('save_source', { sourceId: 'first' }), /прямой просьбе/)
    context.request.text = 'Сохрани первый источник'
    await tools.execute('save_source', { sourceId: 'first' })
    await tools.execute('save_source', { sourceId: 'first' })
    assert.equal(context.bookmarks.length, 1)
    assert.equal(service.memory.chats.saved('alice').length, 0)
    const turn = context.request.turnId
    assert.throws(() => service.memory.chats.commit(context.conversation, 0, turn, 'fingerprint', 'message', context.bookmarks, () => { throw new Error('write failed') }))
    assert.equal(service.memory.chats.saved('alice').length, 0)
    const committed = service.memory.chats.commit(context.conversation, 0, turn, 'fingerprint', 'message', context.bookmarks, () => undefined)
    assert.equal(committed.revision, 1)
    assert.equal(service.memory.chats.saved('alice').length, 1)
    assert.equal(service.memory.chats.saved('bob').length, 0)
    assert.equal(service.memory.chats.replay('alice', committed.id, turn, 'fingerprint'), 'message')
    assert.throws(() => service.memory.chats.replay('alice', committed.id, turn, 'changed'), /другого запроса/)
    assert.throws(() => service.memory.chats.commit(context.conversation, 0, randomUUID(), 'different', 'message2', [], () => undefined), /Диалог изменился/)
  } finally { service.close() }
})

void test('discussion and explicit negative instructions cannot authorize web searches or bookmarks', async () => {
  const { service, context, tools } = setup()
  try {
    context.conversation.brief.query = 'AI agents'
    context.request.text = 'Почему этот тренд считается новым?'
    await assert.rejects(tools.execute('research_now', {}), /Поиск отключён/)
    context.request.text = 'Не ищи в интернете, объясни тренды'
    await assert.rejects(tools.execute('research_now', {}), /Поиск отключён/)
    context.request.text = 'Что у меня в закладках?'
    await assert.rejects(tools.execute('save_source', { sourceId: 'first' }), /прямой просьбе/)
    context.request.text = 'Не сохраняй этот источник'
    await assert.rejects(tools.execute('save_source', { sourceId: 'first' }), /прямой просьбе/)
    assert.equal(context.newReports.length, 0)
    assert.equal(context.bookmarks.length, 0)
  } finally { service.close() }
})

void test('bookmark identity ignores tracking parameters across reports', async () => {
  const { service, context, report, tools } = setup()
  try {
    const other = { ...report, id: randomUUID(), webResults: [evaluationPage('tracked', { url: 'https://first.example.org/article?utm_source=another' })] }
    service.memory.saveReport('alice', other)
    context.request.text = 'Сохрани источники'
    await tools.execute('save_source', { sourceId: 'first' })
    await tools.execute('save_source', { sourceId: 'tracked', reportId: other.id })
    assert.equal(context.bookmarks.length, 1)
    assert.equal(context.bookmarks[0].url, 'https://first.example.org/article')
  } finally { service.close() }
})

void test('research policy accepts natural topic requests while preserving explicit offline and local discussion', () => {
  for (const text of ['Стил мужской 2026 год', 'Мужской стиль', 'Меня интересует мужская мода', 'Источники по мужскому стилю 2026', 'Какие сейчас тренды?', 'Найди новые материалы по этому отчёту']) {
    assert.equal(allowsResearch(text), true, text)
  }
  for (const text of ['Не ищи в интернете, объясни тренды', 'Не нужно искать мужской стиль 2026', 'Не используй интернет, мужской стиль', 'Без нового поиска: мужская мода', 'Только по сохранённым данным', 'Почему этот тренд считается новым?', 'Объясни первый источник', 'Какие тренды в этом отчёте?', 'Покажи источники', '/тема мода', 'Привет']) {
    assert.equal(allowsResearch(text), false, text)
  }
})
