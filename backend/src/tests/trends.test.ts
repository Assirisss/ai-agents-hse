import test from 'node:test'
import assert from 'node:assert/strict'
import type { Evidence, TrendRequest, TrendSource } from '../../../shared/trends.js'
import { createApp } from '../app.js'
import { canonicalUrl, normalizeEvidence, rankTrends } from '../trends/ranking.js'
import { demoReferenceTime } from '../trends/demo.js'
import { FeedCollector, parseFeed } from '../trends/collector.js'
import { OllamaAnalyzer, validateAnalysis, type TrendAnalyzer } from '../trends/analyzer.js'
import { TrendResearchService } from '../trends/service.js'
import { createTrendTool } from '../trends/tool.js'

const now = new Date(demoReferenceTime)
const request: TrendRequest = { mode: 'demo', domain: 'health', query: '', windowDays: 7, limit: 6, enableAi: false }
const source: TrendSource = { id: 'science-fitness', name: 'Test', publisherId: 'sciencedaily', url: 'https://www.sciencedaily.com/rss/health_medicine/fitness.xml', domains: ['health'] }
const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com</link><description>Test</description><item><title>Strength training</title><link>https://example.com/a</link><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate><description><![CDATA[<b>Muscle</b> study]]></description></item></channel></rss>`
const article = (index: number, daysAgo: number, publisherId = 'one'): Evidence => ({
  id: `item-${index}`, title: `Strength training ${index}`, snippet: 'Research on muscle',
  url: `https://example.com/${index}`, publishedAt: new Date(now.getTime() - daysAgo * 86400000).toISOString(),
  sourceId: `${publisherId}-${index}`, publisherId, sourceName: publisherId,
})

void test('demo is reproducible and clearly synthetic; default does not invoke a model', async () => {
  let calls = 0
  const analyzer: TrendAnalyzer = { provider: 'test', async analyze() { calls++; throw new Error('must not run') } }
  const service = new TrendResearchService(new FeedCollector(), analyzer)
  const a = await service.search(request)
  const b = await service.search(request)
  assert.deepEqual(a.articles, b.articles)
  assert.deepEqual(a.trends, b.trends)
  assert.equal(a.referenceTime, demoReferenceTime)
  assert.equal(a.analysis.status, 'disabled')
  assert.equal(calls, 0)
  assert.ok(a.warnings.some((warning) => warning.includes('искусственные')))
  assert.equal(a.trends[0].signal, 'rising')
})

void test('normalization removes trackers, duplicates, invalid URLs and wrong dates', () => {
  const first = article(1, 1)
  const values = [first, { ...first, url: `${first.url}?utm_source=a#top` },
    { ...article(2, 2), title: first.title }, { ...article(3, 2), url: 'javascript:alert(1)' },
    { ...article(4, 2), publishedAt: 'bad' }, article(5, -1), article(6, 15)]
  const normalized = normalizeEvidence(values, request, now)
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].url, first.url)
  assert.equal(canonicalUrl('https://example.com/a?utm_medium=x&b=2&a=1#test'), 'https://example.com/a?a=1&b=2')
})

void test('Russian topic queries match equivalent English keywords', () => {
  const result = normalizeEvidence([article(1, 1)], { ...request, query: 'силовые тренировки' }, now)
  assert.equal(result.length, 1)
})

void test('two feeds from the same publisher are not independent evidence of growth', () => {
  const items = [article(1, 1), article(2, 2), article(3, 3), article(4, 9), article(5, 10)]
  const trend = rankTrends(items, request, now)[0]
  assert.equal(trend.sourceCount, 1)
  assert.equal(trend.signal, 'watch')
  assert.equal(trend.growthPercent, 50)
})

void test('growth requires a baseline and multiple publishers; zero baseline is never infinity', () => {
  const items = [article(1, 1), article(2, 2, 'two'), article(3, 3), article(4, 9), article(5, 10)]
  assert.equal(rankTrends(items, request, now)[0].signal, 'rising')
  const fresh = rankTrends(items.slice(0, 3), request, now)[0]
  assert.equal(fresh.signal, 'new')
  assert.equal(fresh.growthPercent, null)
})

void test('unclassified unrelated publications do not become a rising topic', () => {
  const items = [article(1, 1), article(2, 2, 'two'), article(3, 3), article(4, 9), article(5, 10)]
    .map((item) => ({ ...item, title: 'Unknown topic', snippet: 'Unknown' }))
  assert.equal(rankTrends(items, request, now)[0].signal, 'watch')
})

void test('RSS parsing strips HTML and keeps publication dates', async () => {
  const result = await parseFeed(xml, source)
  assert.equal(result.length, 1)
  assert.equal(result[0].snippet, 'Muscle study')
  assert.equal(result[0].publishedAt, '2026-10-16T12:00:00.000Z')
  assert.equal(result[0].publisherId, 'sciencedaily')
})

void test('collector caches a feed, and expires the cache after ten minutes', async () => {
  let calls = 0
  let time = 0
  const collector = new FeedCollector(async () => { calls++; return new Response(xml) }, () => time)
  assert.equal((await collector.collect([source])).sources[0].cached, false)
  assert.equal((await collector.collect([source])).sources[0].cached, true)
  time = 600001
  assert.equal((await collector.collect([source])).sources[0].cached, false)
  assert.equal(calls, 2)
})

void test('collector blocks redirects to other origins and oversized feeds', async () => {
  let calls = 0
  const redirect = new FeedCollector(async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) })
  assert.equal((await redirect.collect([source])).sources[0].status, 'error')
  assert.equal(calls, 1)
  const huge = new FeedCollector(async () => new Response('x'.repeat(1_000_001)))
  assert.equal((await huge.collect([source])).sources[0].status, 'error')
})

void test('partial source failure is visible; complete failure never falls back to demo', async () => {
  const partial = new FeedCollector(async (url) => String(url).includes('fitness') ? new Response(xml) : new Response('', { status: 503 }))
  const result = await new TrendResearchService(partial, undefined, () => now).search({ ...request, mode: 'live' })
  assert.equal(result.request.mode, 'live')
  assert.equal(result.sources.filter((item) => item.status === 'error').length, 1)
  assert.ok(result.warnings.some((warning) => warning.includes('Часть источников')))
  const failed = new TrendResearchService(new FeedCollector(async () => { throw new Error('offline') }))
  await assert.rejects(() => failed.search({ ...request, mode: 'live' }), /Не удалось загрузить/)
  await assert.rejects(() => failed.search({ ...request, mode: 'live', domain: 'planning' }), /не настроены/)
})

void test('model citations must belong to the claimed trend', async () => {
  const report = await new TrendResearchService().search(request)
  const trend = report.trends[0]
  const valid = { summary: 'Учебные данные', insights: [{ trendId: trend.id, explanation: 'Пример разбора', evidenceIds: [trend.evidenceIds[0]] }] }
  assert.equal(validateAnalysis(valid, report).status, 'ready')
  assert.throws(() => validateAnalysis({ ...valid, insights: [{ ...valid.insights[0], evidenceIds: ['invented'] }] }, report))
  assert.throws(() => validateAnalysis({ ...valid, insights: [{ ...valid.insights[0], trendId: 'invented' }] }, report))
  assert.throws(() => validateAnalysis({ ...valid, toolCall: 'delete' }, report))
})

void test('Ollama adapter requests JSON schema and validates the response', async () => {
  const report = await new TrendResearchService().search(request)
  let calls = 0
  const analyzer = new OllamaAnalyzer('test-model', 'http://127.0.0.1:11434', async (_url, options) => {
    calls++
    const body = JSON.parse(String(options?.body))
    assert.equal(body.stream, false)
    assert.equal(body.model, 'test-model')
    assert.equal(body.format.type, 'object')
    assert.ok(body.messages[0].content.includes('недоверенные'))
    return Response.json({ message: { content: JSON.stringify({ summary: 'Искусственная выборка', insights: [{ trendId: report.trends[0].id, explanation: 'Учебный пример', evidenceIds: [report.trends[0].evidenceIds[0]] }] }) } })
  })
  assert.equal((await analyzer.analyze(report)).status, 'ready')
  assert.equal(calls, 1)
})

void test('model errors preserve the deterministic result and are explicit', async () => {
  const analyzer: TrendAnalyzer = { provider: 'test', async analyze() { throw new Error('failed') } }
  const report = await new TrendResearchService(new FeedCollector(), analyzer).search({ ...request, enableAi: true })
  assert.equal(report.analysis.status, 'unavailable')
  assert.ok(report.articles.length > 0)
  assert.equal((await new TrendResearchService().search({ ...request, enableAi: true })).analysis.status, 'unavailable')
})

void test('research concurrency is limited and releases slots after completion', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const analyzer: TrendAnalyzer = { provider: 'test', async analyze() { await gate; return { status: 'ready', summary: 'Test' } } }
  const service = new TrendResearchService(new FeedCollector(), analyzer)
  const pending = [1, 2, 3].map(() => service.search({ ...request, enableAi: true }))
  await assert.rejects(() => service.search(request), /три исследования/)
  release()
  await Promise.all(pending)
  assert.ok((await service.search(request)).trends.length)
})

void test('HTTP API validates inputs, JSON, origins and body size', async (context) => {
  const app = createApp()
  context.after(() => app.close())
  const meta = await app.inject({ method: 'GET', url: '/api/trends/capabilities' })
  assert.equal(meta.statusCode, 200)
  assert.equal(meta.json().ai.configured, false)
  const valid = await app.inject({ method: 'POST', url: '/api/trends/research', payload: request })
  assert.equal(valid.statusCode, 200)
  assert.ok(valid.json().trends.length)
  for (const payload of [{ ...request, windowDays: -1 }, { ...request, domain: 'unknown' }, { ...request, url: 'http://127.0.0.1' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/trends/research', payload })).statusCode, 400)
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/trends/research', headers: { 'content-type': 'application/json' }, payload: '{bad' })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: '/api/trends/research', headers: { origin: 'https://untrusted.example' }, payload: request })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/trends/research', payload: { ...request, query: 'x'.repeat(9000) } })).statusCode, 413)
})

void test('agent tool uses the same service and defaults to live, never synthetic data', async () => {
  const tool = createTrendTool(new TrendResearchService())
  assert.equal(tool.name, 'search_trends')
  assert.equal((tool.inputSchema.properties as Record<string, { default?: string }>).mode.default, 'live')
  const report = await tool.execute(request)
  assert.equal(report.request.domain, 'health')
  assert.equal(report.request.mode, 'demo')
})

void test('known finance sources are not classified into unrelated wardrobe topics', () => {
  const item = { ...article(1, 1), sourceId: 'ecb', title: 'Economic models and monetary policy', snippet: 'Inflation' }
  const result = rankTrends([item], { ...request, domain: 'all' }, now)
  assert.ok(result.some((trend) => trend.id === 'rates'))
  assert.ok(!result.some((trend) => trend.id === 'fashion'))
})

void test('AI cannot cite publications outside its bounded input', async () => {
  const base = await new TrendResearchService().search(request)
  const articles = Array.from({ length: 50 }, (_, index) => article(index, 1))
  const report = { ...base, articles, trends: [{ ...base.trends[0], evidenceIds: articles.map((item) => item.id) }] }
  const analyzer = new OllamaAnalyzer('test-model', undefined, async () => Response.json({ message: { content: JSON.stringify({ summary: 'Test', insights: [{ trendId: report.trends[0].id, explanation: 'Test', evidenceIds: [articles[45].id] }] }) } }))
  await assert.rejects(() => analyzer.analyze(report), /неизвестную тему или публикацию/)
})
