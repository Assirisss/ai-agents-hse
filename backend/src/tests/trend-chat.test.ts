import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { TrendResearchService } from '../trends/service.js'
import { TrendChatService } from '../trends/chat.js'
import { createApp } from '../app.js'
import { evaluationPage, evaluationReport } from '../evals/fixtures.js'
import type { ResearchPlanner } from '../trends/planner.js'
import type { TrendChatRequest } from '../../../shared/trend-chat.js'
const request = (text: string, revision = 0, extra: Partial<TrendChatRequest> = {}): TrendChatRequest => ({ turnId: randomUUID(), expectedRevision: revision, text, mode: 'demo', enableAi: true, useWeb: false, useModuleContext: false, ...extra })

void test('greeting and brief commands persist a conversation without calling a model', async () => {
  let modelCalls = 0
  const planner: ResearchPlanner = { async next() { modelCalls++; throw new Error('not expected') } }
  const research = new TrendResearchService()
  try {
    const chat = new TrendChatService(research, planner), conversation = chat.create('alice')
    const hello = await chat.send('alice', conversation.id, request('Привет'))
    assert.equal(hello.conversation.messages.length, 2)
    assert.equal(hello.conversation.messages[1].mode, 'tools')
    const topic = await chat.send('alice', conversation.id, request('/тема AI agents', 1))
    assert.equal(topic.conversation.brief.query, 'AI agents')
    const period = await chat.send('alice', conversation.id, request('за месяц', 2))
    assert.equal(period.conversation.brief.windowDays, 30)
    assert.equal(modelCalls, 0)
    assert.equal(research.memory.chats.list('bob').length, 0)
    assert.throws(() => research.memory.chats.get('bob', conversation.id), /не найден/)
  } finally { research.close() }
})

void test('research → filtering → source inspection → bookmarking is a deterministic multi-turn workflow', async () => {
  const research = new TrendResearchService()
  try {
    const chat = new TrendChatService(research), conversation = chat.create('alice')
    let result = await chat.send('alice', conversation.id, request('Найди силовые тренировки за 14 дней'))
    const reportId = result.conversation.activeReportId!
    assert.ok(research.memory.report('alice', reportId))
    assert.equal(result.conversation.brief.windowDays, 14)
    assert.ok(result.conversation.sourceSelection.length > 0)
    result = await chat.send('alice', conversation.id, request('Только прочитанные', 1))
    assert.equal(result.conversation.sourceSelection.length, 0)
    result = await chat.send('alice', conversation.id, request('Покажи все источники', 2))
    assert.ok(result.conversation.sourceSelection.length > 0)
    result = await chat.send('alice', conversation.id, request('/источник 1', 3))
    assert.match(result.conversation.messages.at(-1)!.text, /Полный текст не прочитан/)
    result = await chat.send('alice', conversation.id, request('/сохранить 1', 4))
    assert.equal(research.memory.chats.saved('alice').length, 1)
    result = await chat.send('alice', conversation.id, request('/закладки', 5))
    assert.equal(result.conversation.messages.at(-1)!.citations.length, 1)
    assert.ok(result.conversation.messages.filter((message) => message.role === 'assistant').every((message) => message.mode === 'tools'))
    const attached = chat.create('alice', reportId)
    assert.equal(attached.activeReportId, reportId)
    assert.equal(attached.mode, 'demo')
    assert.throws(() => chat.create('bob', reportId), /сохранённый отчёт/)
  } finally { research.close() }
})

void test('a retried turn is idempotent and a reused turn ID with changed content is rejected', async () => {
  const research = new TrendResearchService()
  try {
    const chat = new TrendChatService(research), conversation = chat.create('alice'), input = request('Привет')
    const first = await chat.send('alice', conversation.id, input)
    const again = await chat.send('alice', conversation.id, input)
    assert.equal(again.replayed, true)
    assert.equal(first.messageId, again.messageId)
    assert.equal(again.conversation.messages.length, 2)
    await assert.rejects(chat.send('alice', conversation.id, { ...input, text: 'different' }), /другого запроса/)
    await assert.rejects(chat.send('alice', conversation.id, request('за месяц', 0)), /Диалог изменился/)
  } finally { research.close() }
})

void test('the model can discuss an existing source and recover from an invented citation and URL without new research', async () => {
  const page = evaluationPage(), report = { ...evaluationReport(), id: randomUUID(), webResults: [page] }
  let turn = 0
  const planner: ResearchPlanner = { async next() {
    const calls = [
      { name: 'inspect_source', arguments: { sourceId: page.id, reportId: report.id } },
      { name: 'finish_chat', arguments: { text: 'Unsupported.', citations: [{ reportId: report.id, sourceId: 'invented' }] } },
      { name: 'finish_chat', arguments: { text: 'https://invented.example.org/fake', citations: [] } },
      { name: 'finish_chat', arguments: { text: 'Источник подчёркивает проверяемые основания; это не доказательство глобального роста.', citations: [{ reportId: report.id, sourceId: page.id }] } },
    ]
    return { content: '', calls: [calls[turn++]] }
  } }
  const research = new TrendResearchService()
  try {
    research.memory.saveReport('alice', report)
    const chat = new TrendChatService(research, planner), conversation = chat.create('alice', report.id)
    const result = await chat.send('alice', conversation.id, request('Объясни ограничения первого источника', 0, { mode: 'live' }))
    const message = result.conversation.messages.at(-1)!
    assert.equal(message.mode, 'model')
    assert.equal(message.citations[0].id, page.id)
    assert.ok(message.steps!.filter((step) => step.tool === 'finish_chat' && step.status === 'error').length >= 2)
    assert.doesNotMatch(message.text, /invented/)
    assert.equal(research.memory.state('alice').runs.length, 1)
  } finally { research.close() }
})

void test('cancellation after collecting a report rolls back the entire unfinished chat turn', async () => {
  let turn = 0
  const planner: ResearchPlanner = { async next() {
    return { content: '', calls: [turn++ === 0 ? { name: 'update_brief', arguments: { query: 'силовые тренировки' } } : { name: 'research_now', arguments: {} }] }
  } }
  const research = new TrendResearchService()
  try {
    const chat = new TrendChatService(research, planner), conversation = chat.create('alice'), controller = new AbortController()
    await assert.rejects(chat.send('alice', conversation.id, request('Подготовь обзор: силовые тренировки'), { signal: controller.signal, onProgress(progress) { if (progress.step?.tool === 'research_now' && progress.step.status === 'ok') controller.abort() } }))
    assert.equal(research.memory.chats.get('alice', conversation.id).messages.length, 0)
    assert.equal(research.memory.state('alice').runs.length, 0)
    assert.equal(research.memory.chats.saved('alice').length, 0)
    const next = await chat.send('alice', conversation.id, request('Привет'))
    assert.equal(next.conversation.revision, 1)
  } finally { research.close() }
})

void test('only one message may run in a conversation; cancellation releases the lock', async () => {
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const planner: ResearchPlanner = { async next(_messages, _tools, signal) {
    resolveStarted()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }
  const research = new TrendResearchService()
  try {
    const chat = new TrendChatService(research, planner), conversation = chat.create('alice'), controller = new AbortController()
    const running = chat.send('alice', conversation.id, request('Обсудим метод исследования'), { signal: controller.signal })
    await started
    await assert.rejects(chat.send('alice', conversation.id, request('Другое сообщение')), /ещё обрабатывается/)
    controller.abort(); await assert.rejects(running)
    assert.equal((await chat.send('alice', conversation.id, request('Привет'))).conversation.revision, 1)
  } finally { research.close() }
})

void test('chat HTTP routes expose the deterministic tool catalog, stream messages and enforce profile scope', async () => {
  const app = createApp()
  try {
    const definitions = (await app.inject('/api/trends/chat/tools')).json()
    assert.equal(definitions.length, 9)
    assert.ok(definitions.some((tool: { name: string; effect: string }) => tool.name === 'filter_sources' && tool.effect === 'read'))
    const created = await app.inject({ method: 'POST', url: '/api/trends/chat/alice/conversations', payload: {} })
    const conversation = created.json()
    assert.equal((await app.inject(`/api/trends/chat/bob/conversations/${conversation.id}`)).statusCode, 404)
    const invalid = await app.inject({ method: 'POST', url: `/api/trends/chat/alice/conversations/${conversation.id}/messages/stream`, payload: { text: 'bad', turnId: 'invalid' } })
    assert.equal(invalid.statusCode, 400)
    const input = request('Привет')
    const response = await app.inject({ method: 'POST', url: `/api/trends/chat/alice/conversations/${conversation.id}/messages/stream`, payload: input })
    assert.match(response.headers['content-type']!, /ndjson/)
    const events = response.body.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(events.at(-1).type, 'result')
    assert.equal(events.at(-1).result.conversation.messages.length, 2)
    const replay = await app.inject({ method: 'POST', url: `/api/trends/chat/alice/conversations/${conversation.id}/messages/stream`, payload: input })
    assert.equal(JSON.parse(replay.body.trim().split('\n').at(-1)!).result.replayed, true)
  } finally { await app.close() }
})

void test('the OpenRouter adapter forces the actual finish_chat tool when the reply budget is reserved', async () => {
  const { OpenRouterPlanner } = await import('../trends/planner.js')
  let choice: unknown
  const planner = new OpenRouterPlanner('test-only', 'openrouter/free', async (_url, init) => {
    choice = JSON.parse(String(init?.body)).tool_choice
    return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'reply-1', function: { name: 'finish_chat', arguments: '{"text":"Готово","citations":[]}' } }] } }] })
  })
  await planner.next([], [{ name: 'finish_chat', description: 'Reply', parameters: { type: 'object' } }], AbortSignal.timeout(1000))
  assert.deepEqual(choice, { type: 'function', function: { name: 'finish_chat' } })
})

void test('conversation messages and bookmarks survive reopening the SQLite file', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { TrendMemory } = await import('../trends/memory.js')
  const directory = mkdtempSync(join(tmpdir(), 'trend-chat-store-')), path = join(directory, 'test.sqlite')
  let memory = new TrendMemory(path)
  try {
    const research = new TrendResearchService(undefined, undefined, undefined, { memory }), chat = new TrendChatService(research)
    const report = { ...evaluationReport(), id: randomUUID(), webResults: [evaluationPage()] }
    memory.saveReport('alice', report)
    const conversation = chat.create('alice', report.id)
    const input = request('/сохранить 1', 0, { mode: 'live' })
    const saved = await chat.send('alice', conversation.id, input)
    memory.close(); memory = new TrendMemory(path)
    assert.equal(memory.chats.get('alice', conversation.id).revision, 1)
    assert.equal(memory.chats.get('alice', conversation.id).messages.at(-1)?.turnId, input.turnId)
    assert.equal(memory.chats.saved('alice').length, 1)
    assert.equal(memory.chats.saved('bob').length, 0)
    assert.equal(saved.conversation.messages.length, 2)
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }) }
})

void test('history numbers resolve deterministically to scoped report IDs for comparison', async () => {
  const research = new TrendResearchService()
  try {
    const first = { ...evaluationReport(), id: randomUUID(), webResults: [evaluationPage()] }
    const second = { ...evaluationReport(), id: randomUUID(), generatedAt: '2026-10-18T13:00:00Z', webResults: [evaluationPage(), evaluationPage('new')] }
    research.memory.saveReport('alice', first); research.memory.saveReport('alice', second)
    const chat = new TrendChatService(research), conversation = chat.create('alice')
    const history = await chat.send('alice', conversation.id, request('/история', 0, { mode: 'live' }))
    assert.equal(history.conversation.reportSelection.length, 2)
    assert.doesNotMatch(history.conversation.messages.at(-1)!.text, /[a-f0-9]{8}-[a-f0-9]{4}/)
    const compared = await chat.send('alice', conversation.id, request('/сравнить 2 1', 1, { mode: 'live' }))
    assert.equal(compared.conversation.messages.at(-1)?.comparison?.added.length, 1)
    assert.equal(compared.conversation.messages.at(-1)?.comparison?.comparable, true)
  } finally { research.close() }
})
