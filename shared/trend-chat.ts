import type { ToolTrace, TrendDomain, TrendMode, TrendReport, ResearchProgress } from './trends.js'

export type TrendBrief = { query: string; domain: TrendDomain; windowDays: number }
export type ChatSource = {
  id: string; reportId: string; mode: TrendMode; title: string; url: string; publishedAt: string | null
  publisher: string; kind: 'rss' | 'news' | 'paper' | 'page'; read: boolean; excerpt: string
}
export type SourceFilter = { query?: string; onlyDated?: boolean; onlyRecent?: boolean; onlyRead?: boolean; publisher?: string; kind?: ChatSource['kind']; limit?: number }
export type ReportComparison = {
  leftId: string; rightId: string; comparable: boolean; notes: string[]
  added: ChatSource[]; repeated: ChatSource[]; missing: ChatSource[]
}
export type SavedTrendSource = { id: string; source: ChatSource; savedAt: string }
export type TrendChatMessage = {
  id: string; turnId?: string; role: 'user' | 'assistant'; text: string; createdAt: string
  citations: ChatSource[]; reportIds: string[]; steps?: ToolTrace[]
  comparison?: ReportComparison; dataMode?: TrendMode; mode?: 'tools' | 'model' | 'fallback'
}
export type TrendConversation = {
  id: string; profileId: string; mode: TrendMode; title: string; revision: number; createdAt: string; updatedAt: string
  brief: TrendBrief; filters: SourceFilter; sourceSelection: ChatSource[]; reportSelection: string[]; activeReportId: string | null; messages: TrendChatMessage[]
}
export type TrendConversationSummary = Pick<TrendConversation, 'id' | 'title' | 'revision' | 'updatedAt'>
export type TrendChatRequest = {
  turnId: string; expectedRevision: number; text: string
  mode: TrendMode; enableAi: boolean; useWeb: boolean; useModuleContext: boolean
}
export type TrendChatResult = { conversation: TrendConversation; messageId: string; replayed: boolean }
export type TrendChatProgress = { message: string; step?: ToolTrace; research?: ResearchProgress; status?: 'queued' | 'running' }
export type TrendChatEvent = { type: 'progress'; progress: TrendChatProgress } | { type: 'result'; result: TrendChatResult } | { type: 'error'; error: string }
export type TrendChatToolContext = {
  conversation: TrendConversation; request: TrendChatRequest
  reports: Map<string, TrendReport>; bookmarks: ChatSource[]; reportIds: Set<string>; newReports: TrendReport[]
}

export type TrendChatToolInfo = { name: string; description: string; effect: 'read' | 'brief' | 'research' | 'bookmark' | 'reply' }
