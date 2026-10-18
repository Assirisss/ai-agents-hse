import type { Evidence, EvidenceQuality, FindingSupport, PersonalizedFinding, ResearchPlan, TrendReport, TrendRequest, WebFinding } from '../../../shared/trends.js'
import { sources } from './catalog.js'
import { canonicalUrl } from './ranking.js'

export function createResearchPlan(request: TrendRequest, topics: string[], referenceTime: string): ResearchPlan {
  return {
    question: request.query || 'Обзор по разрешённым интересам и выбранной области', topics,
    stages: ['Уточнить контекст и прошлые находки', 'Найти свежие материалы и независимые источники', 'Прочитать доступные первоисточники', 'Проверить основания и подготовить обзор'],
    criteria: { minSources: 2, minPublishers: 2, minReadPages: 1 },
    windowStart: new Date(Date.parse(referenceTime) - request.windowDays * 86400000).toISOString(), windowEnd: referenceTime,
  }
}

type Source = { id: string; title: string; url: string; publisher: string; text: string; level: 'page' | 'excerpt' | 'metadata'; recent: boolean; dateKnown: boolean; readable: boolean; fromMemory: boolean }
function publisher(url: string, declared?: string) {
  const host = new URL(url).hostname.replace(/^www\./, '')
  return declared || sources.find((source) => new URL(source.url).hostname.replace(/^www\./, '') === host)?.publisherId || host
}
function recent(date: string | null, report: TrendReport) {
  const time = Date.parse(date || '')
  const now = Date.parse(report.referenceTime)
  return Number.isFinite(time) && time <= now && time >= now - report.request.windowDays * 86400000
}
export function evidenceLedger(report: TrendReport, web: WebFinding[]): Source[] {
  const entries = new Map<string, Source>()
  for (const item of report.articles) {
    const url = canonicalUrl(item.url)
    if (!url) continue
    entries.set(url, { id: item.id, title: item.title, url, publisher: publisher(url, item.publisherId), text: item.snippet, level: 'excerpt', recent: recent(item.publishedAt, report), dateKnown: true, readable: true, fromMemory: false })
  }
  for (const item of web) {
    const url = canonicalUrl(item.url)
    if (!url) continue
    const old = entries.get(url)
    const page = item.read && Boolean(item.text)
    const entry: Source = { id: item.id, title: item.title, url, publisher: publisher(url, item.publisherId), text: page ? item.text! : old?.text || item.snippet,
      level: page ? 'page' : old?.level || 'metadata', recent: recent(item.publishedAt, report) || Boolean(old?.recent), dateKnown: Boolean(item.publishedAt) || Boolean(old?.dateKnown),
      readable: item.readable !== false && new URL(url).hostname !== 'news.google.com', fromMemory: Boolean(item.fromMemory) }
    entries.set(url, entry)
  }
  // Identical syndicated titles are one item of evidence, even on different URLs.
  const titles = new Set<string>()
  return [...entries.values()].filter((item) => {
    const title = item.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (titles.has(title)) return false
    titles.add(title); return true
  })
}

export function assessEvidence(report: TrendReport, web: WebFinding[], plan: ResearchPlan): EvidenceQuality {
  const ledger = evidenceLedger(report, web)
  const publishers = new Set(ledger.filter((item) => item.publisher !== 'news.google.com').map((item) => item.publisher)).size
  const readPages = ledger.filter((item) => item.level === 'page' && !item.fromMemory).length
  const recentSources = ledger.filter((item) => item.recent).length
  const unknownDates = ledger.filter((item) => !item.dateKnown).length
  const gaps = [
    ...(ledger.length < plan.criteria.minSources ? ['Недостаточно разных материалов для обзора.'] : []),
    ...(publishers < plan.criteria.minPublishers ? ['Не хватает независимых издателей; несколько лент одного издателя не дают независимого подтверждения.'] : []),
    ...(readPages < plan.criteria.minReadPages ? ['Нет прочитанного в этом запуске первоисточника; доступны только фрагменты, метаданные или архив.'] : []),
    ...(recentSources < 1 ? ['Нет публикации с подтверждённой датой в выбранном периоде.'] : []),
    ...(unknownDates ? ['У части материалов дата неизвестна; их свежесть не подтверждена.'] : []),
  ]
  return { sources: ledger.length, publishers, readPages, recentSources, unknownDates,
    sufficient: ledger.length >= plan.criteria.minSources && publishers >= plan.criteria.minPublishers && readPages >= plan.criteria.minReadPages && recentSources > 0,
    gaps, nextReadIds: ledger.filter((item) => item.readable && (item.level !== 'page' || item.fromMemory)).sort((a, b) => Number(b.recent) - Number(a.recent)).slice(0, 4).map((item) => item.id) }
}

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
/** Verifies literal support, not the semantic truth of the model's interpretation. */
export function checkQuotes(finding: PersonalizedFinding, articles: Evidence[], web: WebFinding[]) {
  for (const quote of finding.supportingQuotes || []) {
    if (!finding.evidenceIds.includes(quote.evidenceId)) throw new Error('Цитата должна ссылаться на источник этой находки')
    const page = web.find((item) => item.id === quote.evidenceId)
    const article = articles.find((item) => item.id === quote.evidenceId)
    const text = page?.read && page.text ? page.text : article?.snippet || ''
    if (!text || !normalized(text).includes(normalized(quote.quote))) throw new Error('Цитата не найдена в прочитанном тексте или RSS-фрагменте. Прочитайте источник или уберите цитату; не выдумывайте её.')
  }
}
export function findingSupport(finding: PersonalizedFinding, report: TrendReport, web: WebFinding[]): FindingSupport {
  const matches = finding.evidenceIds.flatMap((id) => {
    const page = web.find((item) => item.id === id)
    const article = report.articles.find((item) => item.id === id)
    return page ? evidenceLedger({ ...report, articles: [] }, [page]) : article ? evidenceLedger({ ...report, articles: [article] }, []) : []
  })
  const levels = new Set(matches.map((item) => item.level))
  const publishers = new Set(matches.filter((item) => item.publisher !== 'news.google.com').map((item) => item.publisher)).size
  const recentSources = matches.filter((item) => item.recent).length
  const quotes = finding.supportingQuotes?.length || 0
  return { level: levels.size === 1 ? matches[0].level : 'mixed', publishers, recentSources, verifiedQuotes: quotes,
    limitations: [
      ...(publishers < 2 ? ['Нет подтверждения от двух независимых издателей.'] : []),
      ...(!matches.some((item) => item.level === 'page') ? ['Полный текст основания не прочитан.'] : []),
      ...(!recentSources ? ['Свежесть в выбранном периоде не подтверждена.'] : []),
      ...(!quotes ? ['Текстовый фрагмент в подтверждение вывода не указан.'] : []),
      ...(matches.some((item) => item.fromMemory) ? ['Часть оснований взята из памяти; доступность страницы сейчас может отличаться.'] : []),
    ] }
}
