import type { TrendReport, WebFinding } from '../../../shared/trends.js'
export const referenceTime = '2026-10-18T12:00:00.000Z'
export function evaluationReport(): TrendReport {
  return { id: 'eval', generatedAt: referenceTime, referenceTime, request: { domain: 'planning', query: 'AI agents', mode: 'live', strategy: 'agent', useWeb: true, enableAi: false, windowDays: 7, limit: 6 }, sources: [], articles: [], trends: [], warnings: [], analysis: { status: 'disabled' } }
}
export function evaluationPage(id = 'page-1', overrides: Partial<WebFinding> = {}): WebFinding {
  return { id, title: `AI agents research ${id}`, url: `https://${id}.example.org/article`, snippet: 'Agents require verifiable evidence and clear stopping conditions.', text: 'Agents require verifiable evidence and clear stopping conditions. Measurements apply to this sample only.', publishedAt: '2026-10-17T10:00:00Z', discoveredAt: referenceTime, sourceName: id, publisherId: id, readable: true, read: true, ...overrides }
}
export const evaluationCases = [
  { name: 'Свежий обзор с разными издателями и прочитанным текстом', pages: [evaluationPage(), evaluationPage('page-2')], sufficient: true },
  { name: 'Только поисковая выдача: полные тексты не подтверждены', pages: [evaluationPage('page-1', { read: false, text: undefined }), evaluationPage('page-2', { read: false, text: undefined })], sufficient: false },
  { name: 'Два сайта одного издателя', pages: [evaluationPage('page-1', { publisherId: 'same' }), evaluationPage('page-2', { publisherId: 'same' })], sufficient: false },
  { name: 'Перепечатки одного материала не дают независимое подтверждение', pages: [evaluationPage('page-1', { title: 'Identical syndicated article' }), evaluationPage('page-2', { title: 'Identical syndicated article' })], sufficient: false },
  { name: 'Известные источники без даты не считаются свежими', pages: [evaluationPage('page-1', { publishedAt: null }), evaluationPage('page-2', { publishedAt: null })], sufficient: false },
  { name: 'Старые публикации не подтверждают текущий тренд', pages: [evaluationPage('page-1', { publishedAt: '2025-01-01T12:00:00Z' }), evaluationPage('page-2', { publishedAt: '2025-01-02T12:00:00Z' })], sufficient: false },
  { name: 'Память не выдаётся за новое чтение', pages: [evaluationPage('page-1', { fromMemory: true }), evaluationPage('page-2', { fromMemory: true })], sufficient: false },
]
