import type { AgentReply, AuditEntry, Draft, DraftInput, FinanceState, FinanceStats, Instrument, MarketSummary, Operation, Receipt } from '../../../../shared/finance'

export function financeUrl(path: string) {
  return `/api/finance${path}${path.includes('?') ? '&' : '?'}profileId=default`
}

export async function financeRequest<T>(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(financeUrl(path), {
    method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new Error(value?.error || `Финансовый сервис вернул ошибку ${response.status}.`)
  if (value === null) throw new Error('Финансовый сервис вернул пустой ответ. Обновите данные.')
  return value as T
}

export const getFinanceState = (signal: AbortSignal) => financeRequest<FinanceState>('/state', signal)
export const getFinanceStats = (from: string, to: string, signal: AbortSignal) => financeRequest<FinanceStats>(`/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, signal)
export const createDraft = (input: DraftInput, signal: AbortSignal) => financeRequest<Draft>('/drafts', signal, 'POST', input)
export const saveDraft = (id: string, input: DraftInput, expectedRevision: number, signal: AbortSignal) => financeRequest<Draft>(`/drafts/${encodeURIComponent(id)}`, signal, 'PATCH', { ...input, expectedRevision })
export const confirmDraft = (id: string, expectedRevision: number, signal: AbortSignal) => financeRequest<Operation>(`/drafts/${encodeURIComponent(id)}/confirm`, signal, 'POST', { expectedRevision })
export const updateOperation = (id: string, input: DraftInput, expectedRevision: number, signal: AbortSignal) => financeRequest<Operation>(`/operations/${encodeURIComponent(id)}`, signal, 'PATCH', { ...input, expectedRevision })
export const askFinanceAgent = (text: string, signal: AbortSignal) => financeRequest<AgentReply>('/agent', signal, 'POST', { text })
export const getAudit = (id: string, signal: AbortSignal) => financeRequest<AuditEntry[]>(`/operations/${encodeURIComponent(id)}/audit`, signal)
export const searchInstruments = (query: string, signal: AbortSignal) => financeRequest<Instrument[]>(`/instruments?query=${encodeURIComponent(query)}`, signal)
export const requestSummary = (signal: AbortSignal) => financeRequest<MarketSummary>('/summary', signal, 'POST')
export const recognizeReceipt = (id: string, signal: AbortSignal) => financeRequest<Draft>(`/receipts/${encodeURIComponent(id)}/recognize`, signal, 'POST')

export async function uploadReceipt(file: File, signal: AbortSignal): Promise<Receipt> {
  const response = await fetch(financeUrl('/receipts'), {
    method: 'POST', signal, headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file,
  })
  const value = await response.json().catch(() => null)
  if (!response.ok || !value) throw new Error(value?.error || 'Не удалось загрузить чек.')
  return value as Receipt
}
