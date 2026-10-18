import Parser from 'rss-parser'
import type { Evidence, SourceStatus, TrendSource } from '../../../shared/trends.js'
import { canonicalUrl, plainText } from './ranking.js'
import { readLimitedText } from './http.js'

const parser = new Parser()
export type Collection = { articles: Evidence[]; sources: SourceStatus[] }

export async function parseFeed(xml: string, source: TrendSource): Promise<Evidence[]> {
  const feed = await parser.parseString(xml)
  return feed.items.slice(0, 300).flatMap((item) => {
    const url = canonicalUrl(item.link || '')
    const date = Date.parse(item.isoDate || item.pubDate || '')
    if (!url || !item.title || !Number.isFinite(date)) return []
    return [{
      id: url, sourceId: source.id, sourceName: source.name, publisherId: source.publisherId,
      title: plainText(item.title).slice(0, 300), url,
      publishedAt: new Date(date).toISOString(),
      snippet: plainText(item.contentSnippet || item.content || item.summary || '').slice(0, 1500),
    }]
  })
}

export class FeedCollector {
  private cache = new Map<string, { expiresAt: number; articles: Evidence[] }>()
  constructor(private fetcher: typeof fetch = fetch, private clock = () => Date.now()) {}

  async collect(sources: TrendSource[], outerSignal?: AbortSignal): Promise<Collection> {
    const results = await Promise.all(sources.map(async (source) => {
      const cached = this.cache.get(source.url)
      if (cached && cached.expiresAt > this.clock()) {
        return { articles: cached.articles, status: { sourceId: source.id, name: source.name, status: 'ok', articleCount: cached.articles.length, cached: true } satisfies SourceStatus }
      }
      try {
        let url = new URL(source.url)
        const origin = url.origin
        const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
        let response: Response | undefined
        for (let redirects = 0; redirects <= 3; redirects++) {
          response = await this.fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'AIAgentsHSE/0.1 (RSS research)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            await response.body?.cancel()
            if (!location) throw new Error('Редирект без адреса')
            const next = new URL(location, url)
            if (next.origin !== origin) throw new Error('Редирект за пределы разрешённого источника')
            url = next
            response = undefined
            continue
          }
          break
        }
        if (!response?.ok) throw new Error(response ? `Источник ответил HTTP ${response.status}` : 'Слишком много перенаправлений')
        const xml = await readLimitedText(response, 1_000_000)
        const articles = await parseFeed(xml, source)
        this.cache.set(source.url, { articles, expiresAt: this.clock() + 600000 })
        return { articles, status: { sourceId: source.id, name: source.name, status: 'ok', articleCount: articles.length, cached: false } satisfies SourceStatus }
      } catch (error) {
        return { articles: [], status: { sourceId: source.id, name: source.name, status: 'error', articleCount: 0, cached: false, error: error instanceof Error ? error.message.slice(0, 160) : 'Ошибка источника' } satisfies SourceStatus }
      }
    }))
    return { articles: results.flatMap((result) => result.articles), sources: results.map((result) => result.status) }
  }
}
