import { randomUUID } from 'node:crypto'
import type { Evidence, SourceStatus, TrendReport, TrendCapabilities } from '../../../shared/trends.js'
import { requestSchema, ResearchError } from './schema.js'
import { sources } from './catalog.js'
import { demoArticles, demoReferenceTime } from './demo.js'
import { FeedCollector } from './collector.js'
import { normalizeEvidence, rankTrends } from './ranking.js'
import type { TrendAnalyzer } from './analyzer.js'

export class TrendResearchService {
  private running = 0
  constructor(
    private collector = new FeedCollector(),
    private analyzer?: TrendAnalyzer,
    private clock = () => new Date(),
  ) {}

  capabilities(): TrendCapabilities {
    return { sources, ai: { configured: Boolean(this.analyzer), provider: this.analyzer?.provider ?? null } }
  }

  async search(input: unknown): Promise<TrendReport> {
    const request = requestSchema.parse(input)
    if (this.running >= 3) throw new ResearchError('Уже выполняются три исследования. Повторите чуть позже.', 429)
    this.running++
    try {
      const now = request.mode === 'demo' ? new Date(demoReferenceTime) : this.clock()
      const warnings: string[] = []
      let rawArticles: Evidence[]
      let statuses: SourceStatus[]
      if (request.mode === 'demo') {
        rawArticles = demoArticles(request.domain)
        statuses = [0, 1, 2].map((index) => ({ sourceId: `demo-${index}`, name: `Учебный источник ${index + 1}`, status: 'ok' as const, articleCount: rawArticles.filter((article) => article.sourceId === `demo-${index}`).length, cached: false }))
        warnings.push('Демонстрационные данные искусственные. Опорная дата — 17 октября 2026 года. Это не реальные новости.')
      } else {
        const selected = sources.filter((source) => request.domain === 'all' || source.domains.includes(request.domain))
        if (!selected.length) throw new ResearchError('Для этой области пока не настроены живые источники.', 422)
        const collection = await this.collector.collect(selected)
        rawArticles = collection.articles
        statuses = collection.sources
        if (statuses.every((source) => source.status === 'error')) throw new ResearchError('Не удалось загрузить источники. Проверьте сеть или повторите позже.', 502)
        if (statuses.some((source) => source.status === 'error')) warnings.push('Часть источников недоступна. Результат построен по оставшимся материалам.')
      }
      warnings.push('Сигналы показывают упоминания в полученной выборке. RSS-ленты могут не покрывать оба периода полностью; это не измерение популярности во всём интернете.')
      const articles = normalizeEvidence(rawArticles, request, now)
      const trends = rankTrends(articles, request, now)
      const report: TrendReport = {
        id: randomUUID(), generatedAt: this.clock().toISOString(), referenceTime: now.toISOString(), request,
        sources: statuses, articles, trends, warnings, analysis: { status: 'disabled' },
      }
      if (request.enableAi) {
        if (!this.analyzer) report.analysis = { status: 'unavailable', error: 'AI-разбор не настроен на сервере.' }
        else if (!trends.length) report.analysis = { status: 'unavailable', error: 'Нет материалов для AI-разбора.' }
        else {
          try { report.analysis = await this.analyzer.analyze(report) }
          catch { report.analysis = { status: 'unavailable', provider: this.analyzer.provider, error: 'AI-разбор не удался или ответ не прошёл проверку. Исходные материалы сохранены в результате.' } }
        }
      }
      return report
    } finally { this.running-- }
  }
}
