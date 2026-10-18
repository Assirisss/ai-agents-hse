import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Evidence, WebFinding } from '../../../shared/trends.js'
import { TrendMemory } from '../trends/memory.js'
import { TrendResearchService } from '../trends/service.js'
import { FeedCollector } from '../trends/collector.js'
import { PublicSearch, PublicWebReader, isPublicAddress, parsePage, webEvidence, type WebResearch } from '../trends/web.js'
import type { ResearchPlanner } from '../trends/planner.js'
import { approvedTopics } from '../trends/agent.js'
import { createApp } from '../app.js'

const base = { domain: 'planning', query: 'strength training', windowDays: 7, limit: 6, mode: 'live', enableAi: false, strategy: 'agent', useWeb: true, profileId: 'alice' }
const item = (id = 'web-1', title = 'Strength training and protein'): WebFinding => ({ id, title, url: `https://example.org/${id}`, snippet: 'Research about strength and muscle.', publishedAt: null, discoveredAt: '2026-10-18T12:00:00Z', sourceName: 'example.org', read: false })
function mockWeb() {
  const queries: string[] = []
  const web: WebResearch = { provider: 'test', async search(query) { queries.push(query); return [item(), item('web-2', 'Crypto prices')] }, async read(value) { return { ...value, read: true, text: 'Available source text. '.repeat(20) } } }
  return { web, queries }
}
const offline = () => new FeedCollector(async () => { throw new Error('offline') })

void test('SQLite profile, reports, seen sources and feedback survive reopening and stay scoped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trend-memory-'))
  const path = join(directory, 'memory.sqlite')
  let memory = new TrendMemory(path)
  try {
    memory.saveProfile('alice', { interests: ['strength'], goals: ['A private goal'] })
    const { web } = mockWeb()
    const report = await new TrendResearchService(offline(), undefined, undefined, { memory, web }).search(base)
    memory.feedback('alice', item().url, 'useful')
    memory.close()
    memory = new TrendMemory(path)
    assert.deepEqual(memory.profile('alice').goals, ['A private goal'])
    assert.equal(memory.state('alice').runs.length, 1)
    assert.equal(memory.report('alice', report.id)?.id, report.id)
    assert.equal(memory.report('bob', report.id), null)
    assert.equal(memory.state('bob').runs.length, 0)
    assert.equal(memory.verdict('alice', item().url), 'useful')
    assert.equal(memory.verdict('bob', item().url), null)
    assert.equal(memory.seen('alice', item().url, 'live'), true)
    assert.equal(memory.seen('alice', item().url, 'demo'), false)
    assert.equal(memory.forget('bob', report.id), false)
    assert.equal(memory.forget('alice', report.id), true)
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }) }
})

void test('profile-aware workflow ranks interests, excludes topics and remembers repeats', async () => {
  const memory = new TrendMemory()
  try {
    memory.saveProfile('alice', { interests: ['protein'], excludedTopics: ['Crypto'] })
    const { web } = mockWeb()
    const service = new TrendResearchService(offline(), undefined, undefined, { memory, web })
    const first = await service.search(base)
    assert.equal(first.agent?.mode, 'workflow')
    assert.equal(first.webResults?.length, 1)
    assert.ok(first.webResults?.[0].relevance?.reasons.some((reason) => reason.includes('protein')))
    const again = await service.search(base)
    assert.equal(again.webResults?.[0].relevance?.seenBefore, true)
    memory.feedback('alice', item().url, 'not_useful')
    assert.equal((await service.search(base)).webResults?.length, 0)
  } finally { memory.close() }
})

void test('goals never become web queries; interests need explicit permission', async () => {
  const memory = new TrendMemory()
  try {
    memory.saveProfile('alice', { interests: ['strength training'], goals: ['private personal goal'] })
    const { web, queries } = mockWeb()
    const service = new TrendResearchService(offline(), undefined, undefined, { memory, web })
    const report = await service.search({ ...base, query: '' })
    assert.equal(queries.length, 0)
    assert.ok(report.agent?.stopReason.includes('разрешение'))
    memory.saveProfile('alice', { interests: ['strength training'], goals: ['private personal goal'], allowInterestQueries: true })
    await service.search({ ...base, query: '' })
    assert.deepEqual(queries, ['strength training'])
    assert.deepEqual(approvedTopics(memory.profile('alice'), '').map((topic) => topic.topic), ['strength training'])
  } finally { memory.close() }
})

void test('agent dynamically chooses tools, reads pages and finishes with grounded personalized findings', async () => {
  const memory = new TrendMemory()
  try {
    memory.saveProfile('alice', { interests: ['protein'], goals: ['Learn training basics'] })
    const { web, queries } = mockWeb()
    let turn = 0
    const planner: ResearchPlanner = { async next(messages, tools) {
      assert.ok(tools.some((tool) => tool.name === 'finish_research'))
      if (turn > 0) assert.ok(messages.some((message) => message.role === 'tool'))
      const sequence = [
        { name: 'get_user_context', arguments: {} }, { name: 'search_memory', arguments: { query: 'strength' } },
        { name: 'search_web', arguments: { topicId: 'topic-1', angle: 'research' } },
        { name: 'read_page', arguments: { resultId: 'web-1' } },
        { name: 'finish_research', arguments: { summary: 'Источник найден и прочитан.', findings: [{ title: 'Strength training', summary: 'Разбор источника.', whyRelevant: 'Соответствует цели изучить основы.', evidenceIds: ['web-1'] }] } },
      ]
      return { content: '', calls: [sequence[turn++]] }
    } }
    const result = await new TrendResearchService(offline(), undefined, undefined, { memory, web, planner }).search({ ...base, enableAi: true })
    assert.equal(result.agent?.mode, 'model')
    assert.equal(result.agent?.status, 'completed')
    assert.equal(result.agent?.findings[0].evidenceIds[0], 'web-1')
    assert.equal(result.webResults?.find((value) => value.id === 'web-1')?.read, true)
    assert.deepEqual(queries, ['strength training research evidence'])
  } finally { memory.close() }
})

void test('unknown tools, unapproved queries, arbitrary URLs and invented citations are rejected', async () => {
  const memory = new TrendMemory()
  try {
    const { web, queries } = mockWeb()
    let turn = 0
    const planner: ResearchPlanner = { async next() {
      const calls = [
        { name: 'get_user_context', arguments: {} }, { name: 'shell', arguments: { command: 'cat secret' } },
        { name: 'search_web', arguments: { topicId: 'private goal' } }, { name: 'read_page', arguments: { resultId: 'http://127.0.0.1' } },
        { name: 'finish_research', arguments: { summary: 'Fake', findings: [{ title: 'Fake', summary: 'Fake', whyRelevant: 'Fake', evidenceIds: ['not-collected'] }] } },
      ]
      return { content: '', calls: [calls[turn++ % calls.length]] }
    } }
    const result = await new TrendResearchService(offline(), undefined, undefined, { memory, web, planner }).search({ ...base, enableAi: true })
    assert.ok(result.agent?.steps.some((step) => step.tool === 'shell' && step.status === 'error'))
    assert.ok(result.agent?.steps.some((step) => step.tool === 'finish_research' && step.status === 'error'))
    assert.ok(result.agent?.steps.length <= 12)
    assert.ok(!result.agent?.findings.some((finding) => finding.evidenceIds.includes('not-collected')))
    assert.ok(queries.every((query) => query.startsWith('strength training')))
  } finally { memory.close() }
})

void test('model failure falls back transparently to available tools, not fabricated answers', async () => {
  const memory = new TrendMemory()
  try {
    const { web } = mockWeb()
    const planner: ResearchPlanner = { async next() { throw new Error('model offline') } }
    const report = await new TrendResearchService(offline(), undefined, undefined, { memory, web, planner }).search({ ...base, enableAi: true })
    assert.equal(report.agent?.status, 'limited')
    assert.ok(report.agent?.stopReason.includes('недоступна'))
    assert.ok(report.webResults?.length)
  } finally { memory.close() }
})

void test('demo never contacts the web and remember=false makes no history or observations', async () => {
  const memory = new TrendMemory()
  try {
    const { web, queries } = mockWeb()
    const report = await new TrendResearchService(offline(), undefined, undefined, { memory, web }).search({ ...base, mode: 'demo', remember: false })
    assert.equal(report.request.mode, 'demo')
    assert.equal(queries.length, 0)
    assert.equal(memory.state('alice').runs.length, 0)
    assert.equal(memory.archived('alice').length, 0)
  } finally { memory.close() }
})

void test('web reader rejects private, mapped, mixed and redirected internal addresses before transport', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '224.0.0.1']) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  let sent = 0
  const mixed = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], async () => { sent++; throw new Error('must not connect') })
  await assert.rejects(() => mixed.get('https://public.example'), /непубличный/)
  assert.equal(sent, 0)
  const reader = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }], async (url, pinned) => {
    sent++; assert.equal(pinned.address, '8.8.8.8')
    return { status: 302, headers: { location: 'http://127.0.0.1/private' }, text: '', url: url.toString() }
  })
  await assert.rejects(() => reader.get('https://public.example'), /непубличный/)
  assert.equal(sent, 1)
  await assert.rejects(() => reader.get('file:///etc/passwd'), /Недопустимый/)
  await assert.rejects(() => reader.get('https://a:b@example.org'), /Недопустимый/)
  await assert.rejects(() => reader.get('https://example.org:8080'), /Недопустимый/)
})

void test('DNS lookup obeys cancellation even if the resolver does not finish', async () => {
  const reader = new PublicWebReader(async () => new Promise(() => {}))
  const controller = new AbortController()
  const pending = reader.get('https://public.example', controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(() => pending, /cancelled/)
})

void test('page extraction removes executable markup and does not invent publication dates', () => {
  const html = `<html><head><title>Research</title><script>globalThis.pwned = true</script></head><body><nav>Ignore this</nav><article>${'Useful research content. '.repeat(20)}</article></body></html>`
  const parsed = parsePage(html, item())
  assert.equal(parsed.read, true)
  assert.equal(parsed.publishedAt, null)
  assert.ok(!parsed.text?.includes('globalThis'))
  assert.ok(!parsed.text?.includes('Ignore this'))
  assert.equal(webEvidence(parsed), null)
  const dated = parsePage(html.replace('</head>', '<meta property="article:published_time" content="2026-10-01T12:00:00Z"></head>'), item())
  assert.equal(dated.publishedAt, '2026-10-01T12:00:00.000Z')
  assert.equal(webEvidence(dated, 'health')?.sourceId, 'web:health:example.org')
})

void test('search result timestamps are ignored until the original page supplies a date', async () => {
  const xml = `<rss version="2.0"><channel><title>Search</title><link>https://example.org</link><description>x</description><item><title>Training Research</title><link>https://example.org/article</link><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate><description>Summary</description></item></channel></rss>`
  const reader = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }], async (url) => ({ status: 200, headers: { 'content-type': 'application/xml' }, text: xml, url: url.toString() }))
  const result = await new PublicSearch(reader).search('training', AbortSignal.timeout(1000))
  assert.equal(result[0].publishedAt, null)
  assert.equal(result[0].read, false)
})

void test('archived evidence retains its first publication date and never crosses profiles', () => {
  const memory = new TrendMemory()
  try {
    const evidence: Evidence = { id: 'a', sourceId: 'ecb', sourceName: 'ECB', publisherId: 'ecb', title: 'Inflation', snippet: 'Monetary policy', url: 'https://example.org/a', publishedAt: '2026-10-01T12:00:00Z' }
    memory.archive('alice', [evidence], 'live')
    memory.archive('alice', [{ ...evidence, publishedAt: '2026-10-18T12:00:00Z' }], 'live')
    assert.equal(memory.archived('alice')[0].publishedAt, evidence.publishedAt)
    assert.equal(memory.archived('bob').length, 0)
    memory.archive('alice', [{ ...evidence, url: 'https://example.org/demo' }], 'demo')
    assert.equal(memory.archived('alice').length, 1)
  } finally { memory.close() }
})

void test('profile and memory API validate input and enforce profile scoping for history', async (context) => {
  const app = createApp()
  context.after(() => app.close())
  assert.equal((await app.inject({ method: 'PUT', url: '/api/trends/profiles/alice', payload: { interests: ['training'], goals: ['private'] } })).statusCode, 200)
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/trends/profiles/bob' })).json().goals, [])
  assert.equal((await app.inject({ method: 'PUT', url: '/api/trends/profiles/alice', payload: { hiddenField: true } })).statusCode, 400)
  const report = (await app.inject({ method: 'POST', url: '/api/trends/research', payload: { mode: 'demo', profileId: 'alice', strategy: 'agent' } })).json()
  assert.equal((await app.inject({ method: 'GET', url: `/api/trends/profiles/bob/history/${report.id}` })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: '/api/trends/memory?profileId=alice' })).json().runs.length, 1)
  assert.equal((await app.inject({ method: 'GET', url: '/api/trends/memory?profileId=bob' })).json().runs.length, 0)
  assert.equal((await app.inject({ method: 'POST', url: '/api/trends/feedback', payload: { profileId: 'alice', url: 'javascript:alert(1)', verdict: 'useful' } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trends/profiles/bob/history/${report.id}` })).json().deleted, false)
})

void test('Crossref is a separate research tool with DOI metadata and no invented full text', async () => {
  const json = { message: { items: [{ title: ['Strength training trial'], DOI: '10.1234/test', publisher: 'Test Journal', abstract: '<jats:p>Published abstract.</jats:p>', published: { 'date-parts': [[2026, 1, 2]] }, resource: { primary: { URL: 'https://journal.example/article' } } }] } }
  const reader = new PublicWebReader(async () => [{ address: '8.8.8.8', family: 4 }], async (url) => ({ status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(json), url: url.toString() }))
  const result = await new PublicSearch(reader).papers('strength training', AbortSignal.timeout(1000))
  assert.equal(result[0].sourceName, 'Test Journal')
  assert.equal(result[0].snippet, 'Published abstract.')
  assert.equal(result[0].read, false)
  assert.equal(webEvidence(result[0]), null)
})

void test('memory retrieval can be constrained to the current domain', async () => {
  const memory = new TrendMemory()
  try {
    const service = new TrendResearchService(undefined, undefined, undefined, { memory })
    await service.search({ mode: 'demo', domain: 'finance', profileId: 'alice' })
    await service.search({ mode: 'demo', domain: 'health', profileId: 'alice' })
    assert.equal(memory.recall('alice', '', 'demo', 'health').length, 1)
    assert.equal(memory.recall('alice', '', 'demo', 'all').length, 2)
  } finally { memory.close() }
})

void test('module contexts are validated, profile-scoped and only affect local relevance', async () => {
  const { web, queries } = mockWeb()
  const service = new TrendResearchService(offline(), undefined, undefined, { web })
  const app = createApp(service)
  try {
    const saved = await app.inject({ method: 'PUT', url: '/api/trends/profiles/alice/modules', payload: { module: 'health', source: 'test adapter', facts: ['strength training', 'Private budget 12345'] } })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().updatedAt.length > 0, true)
    assert.deepEqual((await app.inject('/api/trends/profiles/bob/modules')).json(), [])
    assert.equal((await app.inject({ method: 'PUT', url: '/api/trends/profiles/alice/modules', payload: { module: 'health', source: 'test', facts: [], photo: 'private' } })).statusCode, 400)
    const report = await service.search({ ...base, domain: 'health' })
    assert.ok(report.agent?.steps.some((step) => step.tool === 'get_module_context' && step.status === 'ok'))
    assert.ok(report.webResults?.[0].relevance?.reasons.includes('Совпадение с контекстом профиля или разделов'))
    assert.ok(queries.every((query) => !query.includes('12345')))
    const disabled = await service.search({ ...base, domain: 'health', useModuleContext: false })
    assert.equal(disabled.webResults?.[0].relevance?.reasons.includes('Совпадение с контекстом профиля или разделов'), false)
  } finally { await app.close() }
})

void test('wardrobe summaries contain aggregate metadata without photos, names or notes', async () => {
  const { summarizeWardrobe } = await import('../../../frontend/src/modules/trends/moduleContext.js')
  const raw = [{ category: 'tops', color: 'black', season: 'winter', photo: 'secret image', name: 'private name', notes: 'private notes' }, { category: 'tops', color: 'white', season: 'all' }]
  const summary = summarizeWardrobe(raw, 3, 2).join(' ')
  assert.match(summary, /2 вещей/)
  assert.match(summary, /верх — 2/)
  assert.match(summary, /Сохранено образов: 3/)
  assert.doesNotMatch(summary, /secret|private/)
})

void test('OpenRouter tool calls preserve correlation IDs and never expose the key in failures', async () => {
  const { OpenRouterPlanner } = await import('../trends/planner.js')
  let body: Record<string, unknown> = {}
  const planner = new OpenRouterPlanner('test-secret', 'openrouter/free', async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-secret')
    body = JSON.parse(String(options?.body))
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_user_context', arguments: '{}' } }] } }] })
  })
  const result = await planner.next([{ role: 'assistant', content: '', tool_calls: [{ id: 'previous', function: { name: 'get_user_context', arguments: {} } }] }, { role: 'tool', content: '{}', tool_call_id: 'previous', tool_name: 'get_user_context' }], [], AbortSignal.timeout(1000))
  assert.equal(result.calls[0].id, 'call-1')
  const messages = body.messages as { tool_call_id?: string; tool_calls?: { function: { arguments: string } }[] }[]
  assert.equal(messages[1].tool_call_id, 'previous')
  assert.equal(messages[0].tool_calls?.[0].function.arguments, '{}')
  assert.equal(body.model, 'openrouter/free')
  assert.equal('plugins' in body, false)
  const failing = new OpenRouterPlanner('test-secret', undefined, async () => new Response('test-secret', { status: 401 }))
  await assert.rejects(failing.next([], [], AbortSignal.timeout(1000)), (error: Error) => error.message === 'OpenRouter ответил HTTP 401')
})

void test('agent reserves its remaining budget for finishing instead of repeated tool attempts', async () => {
  const { web } = mockWeb()
  let turn = 0
  const planner: ResearchPlanner = { async next(_messages, tools) {
    turn++
    if (tools.length === 1 && tools[0].name === 'finish_research') return { content: '', calls: [{ name: 'finish_research', arguments: { summary: 'Завершено по доступным источникам.', findings: [{ title: 'Strength training', summary: 'Найден источник.', whyRelevant: 'По заданной теме.', evidenceIds: ['web-1'] }] } }] }
    return { content: '', calls: [{ name: turn === 1 ? 'search_web' : 'get_user_context', arguments: turn === 1 ? { topicId: 'topic-1' } : {} }] }
  } }
  const service = new TrendResearchService(offline(), undefined, undefined, { web, planner })
  try {
    const report = await service.search({ ...base, enableAi: true })
    assert.equal(report.agent?.status, 'completed')
    assert.ok(report.agent!.steps.length <= 12)
    assert.ok(turn <= 8)
    assert.equal(report.agent?.steps.at(-1)?.tool, 'finish_research')
    for (const tool of ['get_module_context', 'search_memory', 'get_feed_evidence']) assert.ok(report.agent?.steps.some((step) => step.tool === tool))
  } finally { service.close() }
})
