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
  profileId?: string
  useWeb?: boolean
  strategy?: 'workflow' | 'agent'
  useModuleContext?: boolean
  remember?: boolean
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
  webResults?: WebFinding[]
  agent?: ResearchAgentReport
  personalization?: { profileId: string; interests: string[]; goalsUsed: number; seenCount: number }
}
export type TrendCapabilities = {
  sources: TrendSource[]
  ai: { configured: boolean; provider: string | null }
  web?: { provider: string; configured: boolean }
  agent?: { configured: boolean; tools: string[] }
  memory?: { persistent: boolean }
}


export type TrendProfile = {
  id: string
  interests: string[]
  goals: string[]
  context: string[]
  excludedTopics: string[]
  experience: string
  allowInterestQueries: boolean
  updatedAt: string
}
export type Relevance = { score: number; reasons: string[]; seenBefore: boolean }
export type WebFinding = {
  id: string
  title: string
  url: string
  snippet: string
  text?: string
  publishedAt: string | null
  discoveredAt: string
  sourceName: string
  read: boolean
  publisherId?: string
  kind?: 'news' | 'paper' | 'page'
  readable?: boolean
  fromMemory?: boolean
  relevance?: Relevance
}
export type PersonalizedFinding = {
  title: string; summary: string; whyRelevant: string; evidenceIds: string[]
  supportingQuotes?: { evidenceId: string; quote: string }[]
  support?: FindingSupport
}
export type ToolTrace = { tool: string; status: 'ok' | 'error'; summary: string; durationMs: number; cached?: boolean }
export type ResearchAgentReport = {
  mode: 'model' | 'workflow'
  status: 'completed' | 'limited' | 'unavailable'
  steps: ToolTrace[]
  findings: PersonalizedFinding[]
  summary: string
  stopReason: string
  plan?: ResearchPlan
  quality?: EvidenceQuality
  metrics?: ResearchMetrics
}
export type MemorySummary = {
  id: string; query: string; domain: TrendDomain; mode: TrendMode; createdAt: string
  summary: string; articleCount: number; webCount: number
}
export type MemoryState = { runs: MemorySummary[]; articleCount: number; feedbackCount: number }

export type UserModuleContext = {
  module: 'planning' | 'finance' | 'health' | 'wardrobe'
  source: string
  facts: string[]
  updatedAt: string
}

export type ResearchPlan = {
  question: string
  topics: string[]
  stages: string[]
  criteria: { minSources: number; minPublishers: number; minReadPages: number }
  windowStart: string
  windowEnd: string
}
export type EvidenceQuality = {
  sources: number
  publishers: number
  readPages: number
  recentSources: number
  unknownDates: number
  sufficient: boolean
  gaps: string[]
  nextReadIds: string[]
}
export type FindingSupport = {
  level: 'page' | 'excerpt' | 'metadata' | 'mixed'
  publishers: number
  recentSources: number
  verifiedQuotes: number
  limitations: string[]
}
export type ResearchMetrics = {
  modelCalls: number; toolCalls: number; searches: number; reads: number
  cachedCalls: number; errors: number; durationMs: number
  promptTokens: number; completionTokens: number; costUsd: number | null; models: string[]
}
export type ResearchProgress = {
  stage: 'prepare' | 'collect' | 'research' | 'validate' | 'complete'
  message: string
  plan?: ResearchPlan
  step?: ToolTrace
  quality?: EvidenceQuality
}
export type ResearchStreamEvent = { type: 'progress'; progress: ResearchProgress } | { type: 'result'; report: TrendReport } | { type: 'error'; error: string }
