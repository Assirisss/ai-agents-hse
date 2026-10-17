/** Transport contracts shared by the UI, HTTP API and future agent tools. */
export type TrendDomain = 'all' | 'planning' | 'finance' | 'health' | 'wardrobe'
export type TrendMode = 'demo' | 'live'
export type TrendRequest = {
  domain: TrendDomain
  query: string
  windowDays: number
  limit: number
  mode: TrendMode
  enableAi: boolean
}
export type TrendSource = {
  id: string
  name: string
  publisherId: string
  url: string
  domains: Exclude<TrendDomain, 'all'>[]
}
export type Evidence = {
  id: string
  sourceId: string
  sourceName: string
  publisherId: string
  title: string
  url: string
  publishedAt: string
  snippet: string
}
export type TrendSignal = {
  id: string
  title: string
  currentMentions: number
  previousMentions: number
  growthPercent: number | null
  sourceCount: number
  signal: 'rising' | 'new' | 'watch'
  evidenceIds: string[]
}
export type SourceStatus = {
  sourceId: string
  name: string
  status: 'ok' | 'error'
  articleCount: number
  cached: boolean
  error?: string
}
export type TrendInsight = { trendId: string; explanation: string; evidenceIds: string[] }
export type TrendAnalysis = {
  status: 'disabled' | 'ready' | 'unavailable'
  provider?: string
  summary?: string
  insights?: TrendInsight[]
  error?: string
}
export type TrendReport = {
  id: string
  generatedAt: string
  referenceTime: string
  request: TrendRequest
  sources: SourceStatus[]
  articles: Evidence[]
  trends: TrendSignal[]
  warnings: string[]
  analysis: TrendAnalysis
}
export type TrendCapabilities = {
  sources: TrendSource[]
  ai: { configured: boolean; provider: string | null }
}
