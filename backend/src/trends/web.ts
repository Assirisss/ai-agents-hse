import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { load } from 'cheerio'
import Parser from 'rss-parser'
import type { Evidence, TrendDomain, WebFinding } from '../../../shared/trends.js'
import { canonicalUrl, plainText } from './ranking.js'
import { sources } from './catalog.js'
import { readLimitedText } from './http.js'

export type PublicResponse = { status: number; headers: Record<string, string>; text: string; url: string }
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
export type Transport = (url: URL, address: { address: string; family: number }, signal: AbortSignal) => Promise<PublicResponse>
export interface WebResearch {
  readonly provider: string
  search(query: string, signal: AbortSignal): Promise<WebFinding[]>
  read(item: WebFinding, signal: AbortSignal): Promise<WebFinding>
  papers?(query: string, signal: AbortSignal): Promise<WebFinding[]>
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}

function transport(url: URL, address: { address: string; family: number }, signal: AbortSignal): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    // Connect directly to the checked address, with the original Host and TLS SNI.
    // This prevents a second DNS lookup from rebinding to a private address.
    const req = send({
      protocol: url.protocol, hostname: address.address, family: address.family, port: url.port || undefined,
      servername: url.hostname, path: `${url.pathname}${url.search}`, agent: false, signal,
      headers: { Host: url.host, 'User-Agent': 'AIAgentsHSE/0.2 (research reader)', Accept: 'text/html, application/xhtml+xml, application/rss+xml, application/xml, text/xml, application/json' },
    }, (response) => {
      const status = response.statusCode || 500
      const headers: Record<string, string> = {}
      for (const key of ['location', 'content-type']) headers[key] = String(response.headers[key] || '')
      if (status >= 300 && status < 400) { response.resume(); resolve({ status, headers, text: '', url: url.toString() }); return }
      if (status !== 200) { response.resume(); reject(new Error(`Сайт ответил HTTP ${status}`)); return }
      if (!/html|xml|json|text\/plain/i.test(headers['content-type'])) { response.resume(); reject(new Error('Поддерживаются только HTML, XML, JSON и текст')); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_500_000) { response.destroy(new Error('Страница слишком большая')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status, headers, text: Buffer.concat(chunks).toString('utf8'), url: url.toString() }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

export class PublicWebReader {
  constructor(private resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }), private send: Transport = transport) {}
  async get(value: string, outerSignal?: AbortSignal): Promise<PublicResponse> {
    let url = new URL(value)
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
    for (let attempt = 0; attempt <= 3; attempt++) {
      signal.throwIfAborted()
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Недопустимый адрес страницы')
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (/^(localhost|.*\.(localhost|local|internal))$/i.test(host)) throw new Error('Локальные адреса недоступны инструменту веб-чтения')
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('Истёк срок DNS-запроса'))
        signal.addEventListener('abort', abort, { once: true })
        this.resolver(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
      signal.throwIfAborted()
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error('Сайт указывает на непубличный IP-адрес')
      const pinned = addresses.find((item) => item.family === 4) || addresses[0]
      const response = await this.send(url, pinned, signal)
      if (response.status >= 300 && response.status < 400) {
        if (!response.headers.location) throw new Error('Редирект без адреса')
        url = new URL(response.headers.location, url)
        continue
      }
      if (response.status !== 200) throw new Error(`Сайт ответил HTTP ${response.status}`)
      return response
    }
    throw new Error('Слишком много перенаправлений')
  }
}

function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null
  const date = Date.parse(value)
  return Number.isFinite(date) && date <= Date.now() ? new Date(date).toISOString() : null
}

export function parsePage(html: string, previous: WebFinding): WebFinding {
  const $ = load(html)
  const title = plainText($('meta[property="og:title"]').attr('content') || $('title').first().text() || previous.title).slice(0, 300)
  let date = validDate($('meta[property="article:published_time"], meta[name="date"], meta[itemprop="datePublished"]').first().attr('content'))
  if (!date) {
    for (const element of $('script[type="application/ld+json"]').slice(0, 8).toArray()) {
      try {
        const raw = $(element).text()
        if (raw.length > 50000) continue
        const visit = (value: unknown, depth = 0): string | null => {
          if (!value || typeof value !== 'object' || depth > 5) return null
          if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1)).find(Boolean) || null
          const object = value as Record<string, unknown>
          const kind = String(object['@type'] || '')
          if (/Article|BlogPosting|Report/i.test(kind)) return validDate(object.datePublished)
          return visit(object['@graph'], depth + 1)
        }
        date = visit(JSON.parse(raw))
        if (date) break
      } catch { /* A malformed JSON-LD block does not become a publication date. */ }
    }
  }
  $('script, style, nav, header, footer, aside, form, iframe, noscript, svg').remove()
  const main = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body')
  const text = plainText(main.text()).slice(0, 12000)
  if (/access denied|just a moment|captcha|доступ (ограничен|запрещён)|verify you are human/i.test(title)) throw new Error('Сайт ограничил автоматический доступ; защитная страница не считается публикацией')
  if (text.length < 80) throw new Error('На странице недостаточно доступного текста')
  return { ...previous, title, text, snippet: text.slice(0, 600), publishedAt: date, read: true }
}

export class PublicSearch implements WebResearch {
  readonly provider: string
  constructor(private reader = new PublicWebReader(), private searxUrl?: string, private fetcher: typeof fetch = fetch) { this.provider = searxUrl ? 'searxng' : 'google-news-rss' }
  async search(query: string, signal: AbortSignal): Promise<WebFinding[]> {
    const discoveredAt = new Date().toISOString()
    let items: { title: string; url: string; snippet: string }[]
    if (this.searxUrl) {
      const url = new URL('search', this.searxUrl.endsWith('/') ? this.searxUrl : `${this.searxUrl}/`)
      url.searchParams.set('q', query); url.searchParams.set('format', 'json')
      const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Поисковый сервер ответил HTTP ${response.status}`)
      const value = JSON.parse(await readLimitedText(response, 500000)) as { results?: { title?: string; url?: string; content?: string }[] }
      if (!Array.isArray(value.results)) throw new Error('Некорректный ответ поискового сервера')
      items = value.results.slice(0, 8).map((item) => ({ title: item.title || '', url: item.url || '', snippet: item.content || '' }))
    } else {
      const url = new URL('https://news.google.com/rss/search')
      url.searchParams.set('q', query); url.searchParams.set('hl', 'en-US'); url.searchParams.set('gl', 'US'); url.searchParams.set('ceid', 'US:en')
      const response = await this.reader.get(url.toString(), signal)
      const feed = await new Parser().parseString(response.text)
      items = feed.items.slice(0, 8).map((item) => ({ title: item.title || '', url: item.link || '', snippet: item.contentSnippet || item.content || '' }))
    }
    const seen = new Set<string>()
    return items.flatMap((item) => {
      const url = canonicalUrl(item.url)
      if (!url || !item.title || seen.has(url)) return []
      const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((word) => !['latest', 'news', 'research', 'evidence', 'обзор', 'новости'].includes(word))
      const text = `${item.title} ${item.snippet}`.toLocaleLowerCase()
      if (terms.length && terms.filter((term) => text.includes(term)).length < Math.min(2, terms.length)) return []
      seen.add(url)
      // Search-feed timestamps are not trusted as article publication dates.
      return [{ id: `web-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`, title: plainText(item.title).slice(0, 300), url, snippet: plainText(item.snippet).slice(0, 1000), publishedAt: null, discoveredAt, sourceName: new URL(url).hostname, read: false }]
    })
  }
  async papers(query: string, signal: AbortSignal): Promise<WebFinding[]> {
    const url = new URL('https://api.crossref.org/works')
    url.searchParams.set('query.bibliographic', query)
    url.searchParams.set('rows', '6')
    url.searchParams.set('filter', `from-pub-date:${new Date().getUTCFullYear() - 2}-01-01,type:journal-article`)
    const response = await this.reader.get(url.toString(), signal)
    const value = JSON.parse(response.text) as { message?: { items?: Record<string, unknown>[] } }
    if (!Array.isArray(value.message?.items)) throw new Error('Некорректный ответ Crossref')
    return value.message.items.flatMap((item) => {
      const title = Array.isArray(item.title) && typeof item.title[0] === 'string' ? plainText(item.title[0]) : ''
      const doi = typeof item.DOI === 'string' ? item.DOI : ''
      if (!title || !doi) return []
      const resource = item.resource as { primary?: { URL?: string } } | undefined
      const target = canonicalUrl(resource?.primary?.URL || `https://doi.org/${doi}`)
      if (!target) return []
      const published = (item.published || item['published-online'] || item['published-print']) as { 'date-parts'?: number[][] } | undefined
      const parts = published?.['date-parts']?.[0]
      const publishedAt = parts && parts.length >= 3 ? validDate(`${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}T00:00:00Z`) : null
      const snippet = typeof item.abstract === 'string' ? plainText(item.abstract).slice(0, 1000) : `Научная публикация. DOI: ${doi}. Метаданные Crossref; полный текст может быть недоступен.`
      return [{ id: `paper-${createHash('sha256').update(doi).digest('hex').slice(0, 16)}`, title: title.slice(0, 300), url: target, snippet, publishedAt, discoveredAt: new Date().toISOString(), sourceName: typeof item.publisher === 'string' ? item.publisher : 'Crossref', read: false }]
    })
  }
  async read(item: WebFinding, signal: AbortSignal): Promise<WebFinding> {
    if (new URL(item.url).hostname === 'news.google.com') throw new Error('Новостная выдача ведёт через агрегатор; полный текст первоисточника здесь недоступен')
    const response = await this.reader.get(item.url, signal)
    return parsePage(response.text, { ...item, url: response.url, sourceName: new URL(response.url).hostname })
  }
}

export function webEvidence(item: WebFinding, domain: TrendDomain = 'all'): Evidence | null {
  if (!item.publishedAt || !item.read) return null
  const host = new URL(item.url).hostname.replace(/^www\./, '')
  const known = sources.find((source) => new URL(source.url).hostname.replace(/^www\./, '') === host)
  return { id: item.id, url: item.url, title: item.title, snippet: item.snippet, publishedAt: item.publishedAt, sourceId: known?.id || `web:${domain}:${host}`, sourceName: known?.name || item.sourceName, publisherId: known?.publisherId || host }
}
