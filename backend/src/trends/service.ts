import { randomUUID } from 'node:crypto'
import type { Evidence, SourceStatus, TrendReport, TrendCapabilities } from '../../../shared/trends.js'
import { requestSchema, ResearchError } from './schema.js'
import { sources } from './catalog.js'
import { demoArticles, demoReferenceTime } from './demo.js'
import { FeedCollector } from './collector.js'
import { normalizeEvidence, rankTrends } from './ranking.js'
import type { TrendAnalyzer } from './analyzer.js'
import { TrendMemory } from './memory.js'
import { filterEvidence, relevance } from './personalization.js'
import { PublicSearch, webEvidence, type WebResearch } from './web.js'
import { runResearchAgent, researchTools, approvedTopics } from './agent.js'
import { createResearchPlan } from './quality.js'
import { emitProgress, type ResearchRuntime } from './runtime.js'
import type { ResearchPlanner } from './planner.js'

export type ResearchOptions = { memory?: TrendMemory; web?: WebResearch; planner?: ResearchPlanner }

export class TrendResearchService {
  private running = 0
  readonly memory: TrendMemory
  private web: WebResearch
  private planner?: ResearchPlanner
  constructor(
    private collector = new FeedCollector(), private analyzer?: TrendAnalyzer, private clock = () => new Date(), options: ResearchOptions = {},
  ) { this.memory = options.memory || new TrendMemory(); this.web = options.web || new PublicSearch(); this.planner = options.planner }

  capabilities(): TrendCapabilities {
    return { sources, ai: { configured: Boolean(this.analyzer || this.planner), provider: this.planner?.provider || this.analyzer?.provider || null },
      web: { provider: this.web.provider, configured: true }, agent: { configured: Boolean(this.planner), tools: researchTools }, memory: { persistent: this.memory.persistent } }
  }
  conversationPlanner(): ResearchPlanner | undefined { return this.planner }
  close() { this.memory.close() }

  async search(input: unknown, runtime: ResearchRuntime = {}): Promise<TrendReport> {
    const request = requestSchema.parse(input)
    const deadline = AbortSignal.timeout(118000)
    const signal = runtime.signal ? AbortSignal.any([deadline, runtime.signal]) : deadline
    signal.throwIfAborted()
    if (this.running >= 3) throw new ResearchError('Уже выполняются три исследования. Повторите чуть позже.', 429)
    this.running++
    try {
      const now = request.mode === 'demo' ? new Date(demoReferenceTime) : this.clock()
      const storedProfile = this.memory.profile(request.profileId)
      const modules = request.useModuleContext ? this.memory.moduleContexts(request.profileId).filter((item) => request.domain === 'all' || item.module === request.domain) : []
      const profile = { ...storedProfile, context: [...storedProfile.context, ...modules.flatMap((item) => item.facts)] }
      const plan = createResearchPlan(request, approvedTopics(profile, request.query).map((item) => item.topic), now.toISOString())
      emitProgress(runtime, { stage: 'prepare', message: 'Готовим план и учитываем профиль', plan })
      const warnings: string[] = []
      let rawArticles: Evidence[]
      let statuses: SourceStatus[]
      let fresh: Evidence[] = []
      if (request.mode === 'demo') {
        rawArticles = demoArticles(request.domain)
        statuses = [0, 1, 2].map((index) => ({ sourceId: `demo-${index}`, name: `Учебный источник ${index + 1}`, status: 'ok' as const, articleCount: rawArticles.filter((article) => article.sourceId === `demo-${index}`).length, cached: false }))
        warnings.push('Демонстрационные данные искусственные. Опорная дата — 17 октября 2026 года. Это не реальные новости.')
      } else {
        const selected = sources.filter((source) => request.domain === 'all' || source.domains.includes(request.domain))
        if (!selected.length && !request.useWeb) throw new ResearchError('Для этой области пока не настроены живые источники.', 422)
        emitProgress(runtime, { stage: 'collect', message: 'Собираем публикации из RSS и памяти' })
        const collection = await this.collector.collect(selected, signal)
        signal.throwIfAborted()
        fresh = collection.articles
        statuses = collection.sources
        const previous = this.memory.archived(request.profileId).filter((article) => request.domain === 'all' || selected.some((source) => source.id === article.sourceId) || article.sourceId.startsWith(`web:${request.domain}:`))
        const originalDates = new Map(previous.map((article) => [article.url, article.publishedAt]))
        rawArticles = [...fresh.map((article) => ({ ...article, publishedAt: originalDates.get(article.url) || article.publishedAt })), ...previous]
        if (statuses.length && statuses.every((source) => source.status === 'error') && !previous.length && !request.useWeb) throw new ResearchError('Не удалось загрузить источники. Проверьте сеть или повторите позже.', 502)
        if (statuses.some((source) => source.status === 'error')) warnings.push('Часть источников недоступна. Используем доступные публикации и сохранённую историю.')
      }
      warnings.push('Сигналы показывают упоминания в полученной выборке. RSS-ленты и страницы могут не покрывать оба периода полностью; это не измерение популярности во всём интернете.')
      const articles = filterEvidence(normalizeEvidence(rawArticles, request, now), profile, this.memory, request.mode)
      const trends = rankTrends(articles, request, now)
      const report: TrendReport = {
        id: randomUUID(), generatedAt: this.clock().toISOString(), referenceTime: now.toISOString(), request,
        sources: statuses, articles, trends, warnings, analysis: { status: 'disabled' },
      }
      const useAgent = request.strategy === 'agent' || request.useWeb
      if (useAgent) {
        const result = await runResearchAgent(report, profile, this.memory, this.web, request.enableAi ? this.planner : undefined, { ...runtime, signal })
        report.agent = result.agent
        report.webResults = result.webResults
        const dated = result.webResults.flatMap((item) => { const evidence = webEvidence(item, request.domain); return evidence ? [evidence] : [] })
        report.articles = filterEvidence(normalizeEvidence([...articles, ...dated], request, now), profile, this.memory, request.mode)
        report.trends = rankTrends(report.articles, request, now)
        fresh.push(...dated)
        if (result.webResults.some((item) => !item.publishedAt)) warnings.push('У части веб-страниц дата публикации неизвестна. Они доступны для чтения, но не входят в расчёт роста.')
        if (result.agent.steps.some((step) => step.status === 'error')) warnings.push('Часть инструментов завершилась ошибкой. Откройте журнал исследования для подробностей.')
        if (request.enableAi && !this.planner) report.analysis = { status: 'unavailable', error: 'Планировщик модели не настроен; выполнен обычный сценарий инструментов.' }
      } else if (request.enableAi) {
        if (!this.analyzer) report.analysis = { status: 'unavailable', error: 'AI-разбор не настроен на сервере.' }
        else if (!trends.length) report.analysis = { status: 'unavailable', error: 'Нет материалов для AI-разбора.' }
        else {
          try { report.analysis = await this.analyzer.analyze(report) }
          catch { report.analysis = { status: 'unavailable', provider: this.analyzer.provider, error: 'AI-разбор не удался или ответ не прошёл проверку. Исходные материалы сохранены в результате.' } }
        }
      }
      report.personalization = { profileId: profile.id, interests: profile.interests, goalsUsed: profile.goals.length,
        seenCount: report.articles.filter((article) => relevance(article, profile, this.memory, request.mode).seenBefore).length }
      signal.throwIfAborted()
      if (request.remember) {
        try {
          this.memory.archive(profile.id, filterEvidence(fresh, profile, this.memory, request.mode), request.mode)
          this.memory.saveReport(profile.id, report)
        } catch { warnings.push('Не удалось сохранить исследование в память. Результат доступен в текущем ответе, но может отсутствовать в истории.') }
      }
      emitProgress(runtime, { stage: 'complete', message: 'Обзор готов', quality: report.agent?.quality })
      return report
    } finally { this.running-- }
  }
}
