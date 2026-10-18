import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../app.js'
import { TrendResearchService } from '../trends/service.js'
import { assessEvidence, checkQuotes, createResearchPlan, findingSupport } from '../trends/quality.js'
import { evaluationCases, evaluationPage, evaluationReport } from '../evals/fixtures.js'
import { compactContext } from '../trends/context.js'
import type { ResearchPlanner } from '../trends/planner.js'
import type { WebResearch } from '../trends/web.js'

for (const fixture of evaluationCases) void test(`Evidence evaluation: ${fixture.name}`, () => {
  const report = evaluationReport()
  const quality = assessEvidence(report, fixture.pages, createResearchPlan(report.request, ['AI agents'], report.referenceTime))
  assert.equal(quality.sufficient, fixture.sufficient)
  if (!fixture.sufficient) assert.ok(quality.gaps.length > 0)
})

void test('quotes must occur in actually read text, and belong to the cited finding', () => {
  const report = evaluationReport()
  const page = evaluationPage()
  const finding = { title: 'Agents', summary: 'Evidence matters.', whyRelevant: 'For the course project.', evidenceIds: [page.id], supportingQuotes: [{ evidenceId: page.id, quote: 'Agents require verifiable evidence' }] }
  assert.doesNotThrow(() => checkQuotes(finding, [], [page]))
  assert.equal(findingSupport(finding, report, [page]).verifiedQuotes, 1)
  assert.throws(() => checkQuotes({ ...finding, supportingQuotes: [{ evidenceId: page.id, quote: 'Invented evidence that does not exist' }] }, [], [page]), /Цитата не найдена/)
  assert.throws(() => checkQuotes(finding, [], [{ ...page, read: false }]), /Цитата не найдена/)
  assert.throws(() => checkQuotes({ ...finding, evidenceIds: ['different'] }, [], [page]), /источник этой находки/)
})

void test('tool context stays structured and bounded with adversarially large text', () => {
  const raw = { sources: Array.from({ length: 30 }, (_, index) => ({ id: `web-${index}`, text: 'untrusted page '.repeat(10000), metadata: { title: 'Long title'.repeat(500) } })) }
  const compact = compactContext(raw, 10000)
  const serialized = JSON.stringify(compact)
  assert.ok(serialized.length <= 10000)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.data.sources[0].id, 'web-0')
  assert.equal(typeof parsed.data.sources[0].text, 'string')
})

void test('repeated searches and failed reads are reused without duplicate network work', async () => {
  let searches = 0, reads = 0, turn = 0
  const page = evaluationPage()
  const web: WebResearch = { provider: 'test', async search() { searches++; return [{ ...page, read: false }] }, async read() { reads++; throw new Error('publisher denied access') } }
  const sequence = [
    { name: 'search_web', arguments: { topicId: 'topic-1' } },
    { name: 'search_web', arguments: { topicId: 'topic-1' } },
    { name: 'read_page', arguments: { resultId: page.id } },
    { name: 'read_page', arguments: { resultId: page.id } },
  ]
  const planner: ResearchPlanner = { async next(_messages, tools) {
    const call = sequence[turn++]
    if (!call || tools.length === 1) return { content: '', calls: [{ name: 'finish_research', arguments: { summary: 'Access is limited.', findings: [{ title: page.title, summary: page.snippet, whyRelevant: 'Explicit topic.', evidenceIds: [page.id] }] } }] }
    return { content: '', calls: [call] }
  } }
  const service = new TrendResearchService(undefined, undefined, undefined, { web, planner })
  try {
    const result = await service.search({ domain: 'planning', query: 'AI agents', mode: 'live', useWeb: true, strategy: 'agent', enableAi: true })
    assert.equal(searches, 1)
    assert.equal(reads, 1)
    assert.ok(result.agent!.metrics!.cachedCalls >= 1)
    assert.equal(result.agent!.quality!.sufficient, false)
    assert.ok(result.agent!.findings[0].support!.limitations.length)
  } finally { service.close() }
})

void test('stream API sends a plan, progress, verification and final result, and validates before streaming', async () => {
  const app = createApp()
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/trends/research/stream', payload: { mode: 'invalid' } })
    assert.equal(invalid.statusCode, 400)
    const response = await app.inject({ method: 'POST', url: '/api/trends/research/stream', payload: { mode: 'demo', strategy: 'agent', remember: false } })
    assert.match(response.headers['content-type']!, /ndjson/)
    const events = response.body.trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.type === 'progress' && event.progress.plan))
    assert.ok(events.some((event) => event.type === 'progress' && event.progress.stage === 'validate'))
    assert.equal(events.at(-1).type, 'result')
    assert.equal(events.at(-1).report.request.mode, 'demo')
  } finally { app.server.closeAllConnections(); await app.close() }
})

void test('disconnect cancels the active search, releases its slot and never writes an unfinished report', async () => {
  let interrupted = false
  let resolveStarted!: () => void
  let resolveStopped!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
  const web: WebResearch = { provider: 'test', async search(_query, signal) {
    resolveStarted()
    return new Promise((_resolve, reject) => {
      const abort = () => { interrupted = true; resolveStopped(); reject(signal.reason) }
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
  }, async read(value) { return value } }
  const service = new TrendResearchService(undefined, undefined, undefined, { web })
  const app = createApp(service)
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const controller = new AbortController()
    const response = await fetch(`${address}/api/trends/research/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'planning', query: 'AI agents', mode: 'live', strategy: 'agent', useWeb: true, profileId: 'cancel-test' }), signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    await started
    controller.abort()
    await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Search was not cancelled')), 2000); timer.unref() })])
    assert.equal(interrupted, true)
    assert.equal(service.memory.state('cancel-test').runs.length, 0)
    // Waiting one event-loop turn allows service finally{} to release the in-flight slot.
    await new Promise((resolve) => setImmediate(resolve))
    const next = await service.search({ mode: 'demo', remember: false })
    assert.equal(next.request.mode, 'demo')
    await reader.cancel().catch(() => undefined)
  } finally { app.server.closeAllConnections(); await app.close() }
})

void test('a rejected invented quote can be corrected by the model using actual page text', async () => {
  const page = evaluationPage()
  let turn = 0
  const web: WebResearch = { provider: 'test', async search() { return [{ ...page, read: false, text: undefined }] }, async read() { return page } }
  const planner: ResearchPlanner = { async next() {
    const calls = [
      { name: 'search_web', arguments: { topicId: 'topic-1' } },
      { name: 'read_page', arguments: { resultId: page.id } },
      ...['This phrase is not in the article', 'Agents require verifiable evidence'].map((quote) => ({ name: 'finish_research', arguments: { summary: 'Evidence review.', findings: [{ title: page.title, summary: page.snippet, whyRelevant: 'For the course.', evidenceIds: [page.id], supportingQuotes: [{ evidenceId: page.id, quote }] }] } })),
    ]
    return { content: '', calls: [calls[turn++]] }
  } }
  const service = new TrendResearchService(undefined, undefined, undefined, { web, planner })
  try {
    const report = await service.search({ domain: 'planning', query: 'AI agents', mode: 'live', useWeb: true, strategy: 'agent', enableAi: true })
    assert.equal(report.agent?.status, 'completed')
    assert.ok(report.agent?.steps.some((step) => step.tool === 'finish_research' && step.status === 'error'))
    assert.equal(report.agent?.findings[0].support?.verifiedQuotes, 1)
    assert.equal(report.agent?.findings[0].supportingQuotes?.[0].quote, 'Agents require verifiable evidence')
  } finally { service.close() }
})

void test('news search requests the selected period and extracts publisher identity without trusting feed dates', async () => {
  const { PublicSearch, PublicWebReader } = await import('../trends/web.js')
  let requested = ''
  const reader = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }], async (url) => {
    requested = url.toString()
    return { status: 200, headers: {}, url: requested, text: '<rss version="2.0"><channel><title>Search</title><item><title>AI agents research</title><link>https://news.google.com/rss/articles/example</link><description>AI agents research update</description><pubDate>Sat, 17 Oct 2026 12:00:00 GMT</pubDate><source url="https://publisher.example.org">Publisher</source></item></channel></rss>' }
  })
  const pages = await new PublicSearch(reader).search('AI agents', AbortSignal.timeout(1000), { windowDays: 7, referenceTime: '2026-10-18T12:00:00Z' })
  assert.match(new URL(requested).searchParams.get('q')!, /after:2026-10-11/)
  assert.equal(pages[0].publisherId, 'publisher.example.org')
  assert.equal(pages[0].readable, false)
  assert.equal(pages[0].publishedAt, null)
})

void test('Crossref period is explicit and provider usage is observed without inventing a price', async () => {
  const { PublicSearch, PublicWebReader } = await import('../trends/web.js')
  const { OpenRouterPlanner } = await import('../trends/planner.js')
  let requested = ''
  const reader = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }], async (url) => {
    requested = url.toString()
    return { status: 200, headers: {}, url: requested, text: JSON.stringify({ message: { items: [] } }) }
  })
  await new PublicSearch(reader).papers('AI agents', AbortSignal.timeout(1000), { windowDays: 7, referenceTime: '2026-10-18T12:00:00Z' })
  assert.match(new URL(requested).searchParams.get('filter')!, /from-pub-date:2026-10-11/)
  const planner = new OpenRouterPlanner('test-only', 'openrouter/free', async () => Response.json({ model: 'actual/free-model', usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0 }, choices: [{ message: { content: 'done' } }] }))
  const result = await planner.next([], [], AbortSignal.timeout(1000))
  assert.equal(result.model, 'actual/free-model')
  assert.deepEqual(result.usage, { promptTokens: 200, completionTokens: 30, costUsd: 0 })
})

void test('free router selection is pinned within a run without leaking into another run', async () => {
  const { OpenRouterPlanner } = await import('../trends/planner.js')
  const requested: string[] = []
  const planner = new OpenRouterPlanner('test-only', 'openrouter/free', async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model
    requested.push(model)
    return Response.json({ model: model === 'openrouter/free' ? `provider/free-${requested.length}:free` : model, choices: [{ message: { content: 'ok' } }] })
  })
  const first = planner.forRun(), second = planner.forRun()
  await first.next([], [], AbortSignal.timeout(1000))
  await first.next([], [], AbortSignal.timeout(1000))
  await second.next([], [], AbortSignal.timeout(1000))
  assert.deepEqual(requested, ['openrouter/free', 'provider/free-1:free', 'openrouter/free'])
})
