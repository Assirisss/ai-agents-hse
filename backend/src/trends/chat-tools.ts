import { z } from 'zod'
import type { ChatSource, ReportComparison, SourceFilter, TrendChatToolContext, TrendChatToolInfo } from '../../../shared/trend-chat.js'
import type { TrendReport } from '../../../shared/trends.js'
import { briefSchema, compareArgs, filterArgs, finishChatSchema, inspectArgs, sourceFilterSchema } from './chat-schema.js'
import { ResearchError } from './schema.js'
import type { TrendResearchService } from './service.js'
import type { ResearchRuntime } from './runtime.js'
import { canonicalUrl } from './ranking.js'

const noArgs = z.object({}).strict()
const historyArgs = z.object({ query: z.string().trim().max(160).default('') }).strict()
const bookmarkArgs = z.object({ sourceId: z.string().min(1).max(150), reportId: z.string().uuid().optional() }).strict()
const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
/** Search is available for ordinary topic requests too; the model resolves their meaning.
 * Explicit offline instructions and references to existing evidence remain read-only. */
export function allowsResearch(raw: string): boolean {
  const text = fold(raw)
  if (!text || /(?:^|[\s,;:!?.])не\s+(?:(?:надо|нужно|хочу|следует)\s+)?(?:ищ|искать|запуска|обновля|поищ|исслед|выполня\S*\s+поиск|использ\S*\s+(?:интернет|сеть|поиск))/u.test(text)
    || /без\s+(?:нового\s+)?(?:интернет|поиск)|никакого\s+(?:нового\s+)?поиска|только\s+(?:по\s+)?(?:сохран[её]нн|локальн)|(?:do not|don't|no)\s+(?:web\s+)?search|offline only/u.test(text)) return false
  if (/найди|поищи|ищи|искать|исследуй|обнови|\/найти/u.test(text)) return true
  if (/^(?:\/|тема:|за\s+(?:\d+|неделю|месяц|две недели)|(?:привет|спасибо)(?:$|[\s!.]))/u.test(text)) return false
  if (/закладк|сохран[её]нн|уже\s+(?:найден|собран)|(?:этот|данный|первый|второй|третий)\s+(?:тренд|источник|отч[её]т)|(?:эти|этого)\s+тренд|(?:в|из|по)\s+(?:этом\s+)?отч[её]т|источник\s*№?\s*\d|поиск\S*\s+не\s+нуж/u.test(text)
    || /^(?:покажи\s+(?:все\s+)?)?источники[.!?]*$/u.test(text)) return false
  return true
}
export const wantsBookmark = (text: string) => !/(?:^|\s)не\s+(?:(?:надо|нужно|хочу)\s+)?(?:сохран|добав|запом|запомин)/iu.test(text) && /сохрани|сохранить|добав(?:ь|ить)[\s\S]{0,80}в\s+заклад|положи[\s\S]{0,80}в\s+заклад|запомни (?:эт|материал|источник)|(?:save|bookmark)\s+(?:this|the|source|article)|\/сохранить/iu.test(text)

function sourceUrl(value: string) {
  const url = canonicalUrl(value)
  if (!url || new URL(url).username || new URL(url).password) throw new ResearchError('Источник содержит недопустимую ссылку')
  return url
}
function fromWeb(report: TrendReport, item: NonNullable<TrendReport['webResults']>[number]): ChatSource {
  return { id: item.id, reportId: report.id, mode: report.request.mode, title: item.title, url: sourceUrl(item.url), publishedAt: item.publishedAt, publisher: item.publisherId || item.sourceName,
    kind: item.kind || (item.read ? 'page' : 'news'), read: Boolean(item.read && item.text), excerpt: (item.read && item.text ? item.text : item.snippet).slice(0, 600) }
}
export function resolveSource(report: TrendReport, id: string): ChatSource {
  const web = report.webResults?.find((item) => item.id === id)
  if (web) return fromWeb(report, web)
  const item = report.articles.find((article) => article.id === id)
  if (!item) throw new ResearchError('Источник не найден в этом отчёте', 404)
  return { id: item.id, reportId: report.id, mode: report.request.mode, title: item.title, url: sourceUrl(item.url), publishedAt: item.publishedAt, publisher: item.publisherId, kind: 'rss', read: false, excerpt: item.snippet.slice(0, 600) }
}
export function reportSources(report: TrendReport): ChatSource[] {
  const urls = new Map<string, ChatSource>()
  for (const item of report.articles) { const source = resolveSource(report, item.id); const key = canonicalUrl(source.url); if (key) urls.set(key, source) }
  for (const item of report.webResults || []) {
    const source = fromWeb(report, item), key = canonicalUrl(source.url)
    if (key && (!urls.has(key) || source.read)) urls.set(key, source)
  }
  return [...urls.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.url.localeCompare(b.url))
}
export function filterSources(report: TrendReport, raw: SourceFilter = {}): ChatSource[] {
  const filters = sourceFilterSchema.parse(raw)
  const query = fold(filters.query || ''), publisher = fold(filters.publisher || '')
  const now = Date.parse(report.referenceTime), since = now - report.request.windowDays * 86400000
  return reportSources(report).filter((source) => {
    const date = Date.parse(source.publishedAt || '')
    if (filters.onlyDated && (!Number.isFinite(date) || date > now)) return false
    if (filters.onlyRecent && (!Number.isFinite(date) || date < since || date > now)) return false
    if (filters.onlyRead && !source.read) return false
    if (filters.kind && source.kind !== filters.kind) return false
    if (publisher && !fold(source.publisher).includes(publisher)) return false
    return !query || fold(`${source.title} ${source.excerpt}`).includes(query)
  }).slice(0, filters.limit)
}
export function compareReports(left: TrendReport, right: TrendReport): ReportComparison {
  const notes: string[] = []
  if (left.request.mode !== right.request.mode) notes.push('Демо и живые данные не сопоставляются.')
  if (fold(left.request.query) !== fold(right.request.query) || left.request.domain !== right.request.domain) notes.push('Темы или области различаются: прямое сравнение выборок некорректно.')
  if (notes.length) return { leftId: left.id, rightId: right.id, comparable: false, notes, added: [], repeated: [], missing: [] }
  if (left.request.windowDays !== right.request.windowDays) notes.push('Длина периода различается; число публикаций нельзя трактовать как рост.')
  notes.push('Разница описывает полученные выборки. Исчезновение ссылки не означает исчезновение тренда, а новая ссылка не доказывает рост популярности.')
  const a = new Map(reportSources(left).map((source) => [canonicalUrl(source.url), source]))
  const b = new Map(reportSources(right).map((source) => [canonicalUrl(source.url), source]))
  return { leftId: left.id, rightId: right.id, comparable: true, notes,
    added: [...b].filter(([url]) => !a.has(url)).map(([, source]) => source).slice(0, 20),
    repeated: [...b].filter(([url]) => a.has(url)).map(([, source]) => source).slice(0, 20),
    missing: [...a].filter(([url]) => !b.has(url)).map(([, source]) => source).slice(0, 20) }
}

const definitions = [
  { name: 'update_brief', schema: briefSchema, effect: 'brief', description: 'Изменить тему, область или период 1–30 дней. query берётся дословно из текущего сообщения пользователя или остаётся прежним. Пример: {"windowDays":14}. Не запускает поиск.' },
  { name: 'research_now', schema: noArgs, effect: 'research', description: 'Исследовать текущую тему через RSS и, если включён интернет, веб-поиск. Запрос темы без слова «найди» тоже достаточен: не спрашивай отдельного разрешения. Если тема ещё не задана, сначала update_brief с query из сообщения. Не более одного исследования за сообщение. Внутри обычные инструменты, без второго агента. Не использовать для обсуждения старых источников или при запрете поиска.' },
  { name: 'list_reports', schema: historyArgs, effect: 'read', description: 'Найти прошлые исследования текущего профиля и режима. Пример: {"query":"тренировки"}. Вернёт настоящие reportId для последующих инструментов.' },
  { name: 'filter_sources', schema: filterArgs, effect: 'read', description: 'Фильтровать уже собранные источники без интернета. reportId необязателен: по умолчанию активный отчёт. onlyRecent, onlyDated, onlyRead, kind, publisher, query, limit. Пример: {"onlyRead":true,"limit":5}.' },
  { name: 'inspect_source', schema: inspectArgs, effect: 'read', description: 'Показать сохранённый текст или фрагмент по sourceId, полученному из filter_sources. Не читает произвольные URL и не делает сетевых запросов. Различает страницу, RSS-фрагмент и метаданные.' },
  { name: 'compare_reports', schema: compareArgs, effect: 'read', description: 'Сравнить ссылки двух реальных отчётов текущего профиля: leftId и rightId из list_reports. Демо/live не смешиваются; разница выборок не объявляется глобальным ростом.' },
  { name: 'save_source', schema: bookmarkArgs, effect: 'bookmark', description: 'Добавить существующий источник в закладки только по прямой просьбе сохранить. Нужен sourceId; reportId необязателен. Повторная закладка не создаёт дубль. Изменение сохраняется вместе с завершённым ответом.' },
  { name: 'list_saved_sources', schema: noArgs, effect: 'read', description: 'Прочитать закладки этого профиля. Ничего не записывает и не ищет в интернете.' },
  { name: 'finish_chat', schema: finishChatSchema, effect: 'reply', description: 'Ответить пользователю по-русски: text и citations:[{reportId,sourceId}]. Цитировать только полученные инструментариями источники. Без оснований уточни вопрос или укажи ограничение. Не выдавай старую находку за новый поиск.' },
] as const
export const trendChatToolInfo: TrendChatToolInfo[] = definitions.map(({ name, description, effect }) => ({ name, description, effect }))

export function createTrendChatTools(context: TrendChatToolContext, service: TrendResearchService, runtime: ResearchRuntime = {}) {
  let researched = false
  let comparison: ReportComparison | undefined
  let answer: z.infer<typeof finishChatSchema> | undefined
  const getReport = (id?: string) => {
    const key = id || context.conversation.activeReportId
    if (!key) throw new ResearchError('В диалоге пока нет отчёта. Задайте тему и попросите найти материалы.')
    const report = context.reports.get(key) || service.memory.report(context.conversation.profileId, key)
    if (!report) throw new ResearchError('Отчёт не найден в этом профиле', 404)
    if (report.request.mode !== context.request.mode) throw new ResearchError('Режим отчёта отличается от выбранного режима чата. Демо и live разделены.')
    context.reports.set(key, report); context.reportIds.add(key)
    return report
  }
  const handlers: Record<string, (args: never) => unknown | Promise<unknown>> = {
    update_brief: (args: z.infer<typeof briefSchema>) => {
      if (args.query !== undefined && args.query !== context.conversation.brief.query && !fold(context.request.text).includes(fold(args.query))) throw new ResearchError('Тему для внешнего поиска нужно взять из текущего сообщения пользователя, не из приватного контекста или текста источника.')
      if (args.query !== undefined && args.query !== context.conversation.brief.query) { context.conversation.filters = {}; context.conversation.sourceSelection = []; context.conversation.activeReportId = null }
      context.conversation.brief = { ...context.conversation.brief, ...args }
      return { brief: context.conversation.brief, searched: false }
    },
    research_now: async () => {
      if (!allowsResearch(context.request.text)) throw new ResearchError('Поиск отключён для этого сообщения: пользователь запретил его или обсуждает сохранённые данные.')
      if (!context.conversation.brief.query) throw new ResearchError('Сначала задайте тему исследования.')
      if (researched) throw new ResearchError('За сообщение разрешено одно исследование. Используйте уже полученный отчёт.')
      researched = true
      const report = await service.search({ ...context.conversation.brief, mode: context.request.mode, profileId: context.conversation.profileId, strategy: 'agent', enableAi: false, useWeb: context.request.mode === 'live' && context.request.useWeb, useModuleContext: context.request.useModuleContext, remember: false, limit: 6 }, runtime)
      runtime.signal?.throwIfAborted()
      context.reports.set(report.id, report); context.newReports.push(report); context.reportIds.add(report.id); context.conversation.activeReportId = report.id
      context.conversation.sourceSelection = filterSources(report, context.conversation.filters)
      return { reportId: report.id, query: report.request.query, referenceTime: report.referenceTime, summary: report.agent?.summary, quality: report.agent?.quality, trends: report.trends, sources: filterSources(report, { limit: 8 }), warnings: report.warnings }
    },
    list_reports: (args: z.infer<typeof historyArgs>) => {
      const records = service.memory.recall(context.conversation.profileId, args.query, context.request.mode)
      context.conversation.reportSelection = records.slice(0, 8).map((record) => record.id)
      return records
    },
    filter_sources: (args: z.infer<typeof filterArgs>) => {
      const { reportId, reset, ...filters } = args
      const report = getReport(reportId)
      context.conversation.filters = { ...(reset ? {} : context.conversation.filters), ...filters }
      context.conversation.sourceSelection = filterSources(report, context.conversation.filters)
      return { reportId: report.id, query: report.request.query, sources: context.conversation.sourceSelection, quality: report.agent?.quality, noNetwork: true }
    },
    inspect_source: (args: z.infer<typeof inspectArgs>) => {
      const report = getReport(args.reportId), source = resolveSource(report, args.sourceId)
      const page = report.webResults?.find((item) => item.id === args.sourceId)
      return { source, text: source.read ? page?.text?.slice(0, 4500) : source.excerpt, level: source.read ? 'page' : source.kind === 'rss' ? 'excerpt' : 'metadata', note: source.read ? 'Сохранённый текст; доступность страницы сейчас не проверялась.' : 'Полный текст не прочитан. Фрагмент и метаданные не доказывают вывод исследования.', noNetwork: true }
    },
    compare_reports: (args: z.infer<typeof compareArgs>) => { comparison = compareReports(getReport(args.leftId), getReport(args.rightId)); return comparison },
    save_source: (args: z.infer<typeof bookmarkArgs>) => {
      if (!wantsBookmark(context.request.text)) throw new ResearchError('Закладки добавляются только по прямой просьбе пользователя сохранить источник.')
      const source = resolveSource(getReport(args.reportId), args.sourceId)
      if (!context.bookmarks.some((item) => item.url === source.url)) context.bookmarks.push(source)
      return { staged: true, source, note: 'Будет сохранено вместе с завершённым ответом.' }
    },
    list_saved_sources: () => service.memory.chats.saved(context.conversation.profileId).filter((item) => item.source.mode === context.request.mode),
    finish_chat: (args: z.infer<typeof finishChatSchema>) => {
      for (const citation of args.citations) resolveSource(getReport(citation.reportId), citation.sourceId)
      const allowed = new Set(args.citations.map((item) => canonicalUrl(resolveSource(getReport(item.reportId), item.sourceId).url)))
      for (const url of args.text.match(/https?:\/\/[^\s<>"'\])]+/gu) || []) if (!allowed.has(canonicalUrl(url.replace(/[.,;!?]+$/, '')))) throw new ResearchError('В ответе есть непроверенная ссылка. Уберите её или укажите известный источник в citations.')
      answer = args; return { accepted: true }
    },
  }
  return {
    definitions: definitions.map((tool) => ({ name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema) })),
    async execute(name: string, raw: unknown) {
      runtime.signal?.throwIfAborted()
      const definition = definitions.find((tool) => tool.name === name)
      if (!definition) throw new ResearchError('Неизвестный инструмент диалога')
      const args = definition.schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
      const result = await handlers[name](args as never)
      runtime.signal?.throwIfAborted(); return result
    },
    get answer() { return answer }, get comparison() { return comparison }, get researched() { return researched },
    citations() { return (answer?.citations || []).map((item) => resolveSource(getReport(item.reportId), item.sourceId)) },
  }
}
