import { createHash } from 'node:crypto'
import type { Evidence, TrendRequest, TrendSignal } from '../../../shared/trends.js'
import { sources, topics } from './catalog.js'

export function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key.toLowerCase())) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.toString()
  } catch { return null }
}

export function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim()
}

export function normalizeEvidence(input: Evidence[], request: TrendRequest, now: Date): Evidence[] {
  const earliest = now.getTime() - request.windowDays * 2 * 86400000
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  const query = request.query.toLocaleLowerCase().trim()
  const matchingTopics = topics.filter((topic) =>
    topic.title.toLocaleLowerCase().includes(query) || topic.terms.some((term) => query.includes(term)),
  )
  const terms = [...query.split(/\s+/).filter((term) => term.length > 1), ...matchingTopics.flatMap((topic) => topic.terms)]
  const result: Evidence[] = []

  for (const article of [...input].sort((a, b) => a.url.localeCompare(b.url))) {
    const url = canonicalUrl(article.url)
    const date = Date.parse(article.publishedAt)
    const title = plainText(article.title).slice(0, 300)
    const titleKey = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (!url || !titleKey || !Number.isFinite(date) || date > now.getTime() || date < earliest) continue
    const snippet = plainText(article.snippet).slice(0, 1500)
    const content = `${title} ${snippet}`.toLocaleLowerCase()
    if (query && !terms.some((term) => content.includes(term))) continue
    if (seenUrls.has(url) || seenTitles.has(titleKey)) continue
    seenUrls.add(url)
    seenTitles.add(titleKey)
    result.push({ ...article, id: createHash('sha256').update(url).digest('hex').slice(0, 16), title, snippet, url, publishedAt: new Date(date).toISOString() })
  }
  return result.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
}

export function rankTrends(articles: Evidence[], request: TrendRequest, now: Date): TrendSignal[] {
  const boundary = now.getTime() - request.windowDays * 86400000
  const eligible = topics.filter((topic) => request.domain === 'all' || topic.domains.includes(request.domain))
  const groups = eligible.map((topic) => ({
    id: topic.id, title: topic.title,
    evidence: articles.filter((article) => {
      const source = sources.find((candidate) => candidate.id === article.sourceId)
      if (source && !source.domains.some((domain) => topic.domains.includes(domain))) return false
      return topic.terms.some((term) => `${article.title} ${article.snippet}`.toLocaleLowerCase().includes(term))
    }),
  }))
  const grouped = new Set(groups.flatMap((group) => group.evidence.map((article) => article.id)))
  const unmatched = articles.filter((article) => !grouped.has(article.id))
  if (unmatched.length) groups.push({ id: 'other', title: request.query || 'Другие материалы по запросу', evidence: unmatched })

  return groups.map((group): TrendSignal => {
    const current = group.evidence.filter((article) => Date.parse(article.publishedAt) >= boundary)
    const previous = group.evidence.length - current.length
    const sourceCount = new Set(current.map((article) => article.publisherId)).size
    const growthPercent = previous > 0 ? Math.round((current.length / previous - 1) * 100) : null
    // This measures mentions in the retrieved sample, not global popularity.
    const rising = group.id !== 'other' && current.length >= 3 && previous >= 2 && sourceCount >= 2 && growthPercent !== null && growthPercent >= 50
    return {
      id: group.id, title: group.title, currentMentions: current.length, previousMentions: previous,
      growthPercent, sourceCount, signal: rising ? 'rising' : previous === 0 && group.id !== 'other' ? 'new' : 'watch',
      evidenceIds: group.evidence.map((article) => article.id),
    }
  }).filter((trend) => trend.currentMentions > 0)
    .sort((a, b) => Number(b.signal === 'rising') - Number(a.signal === 'rising') || b.currentMentions - a.currentMentions || a.id.localeCompare(b.id))
    .slice(0, request.limit)
}
