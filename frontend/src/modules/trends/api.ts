import type { TrendCapabilities, TrendReport, TrendRequest, TrendProfile, MemoryState, UserModuleContext } from '../../../../shared/trends'

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error || 'Служба поиска недоступна. Проверьте, что backend запущен.')
  return data as T
}

export const getCapabilities = (signal: AbortSignal) => fetch('/api/trends/capabilities', { signal }).then(readJson<TrendCapabilities>)
export const researchTrends = (request: TrendRequest, signal: AbortSignal) => fetch('/api/trends/research', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
}).then(readJson<TrendReport>)

const profileId = 'default'
export const getProfile = (signal: AbortSignal) => fetch(`/api/trends/profiles/${profileId}`, { signal }).then(readJson<TrendProfile>)
export const saveProfile = (value: Omit<TrendProfile, 'id' | 'updatedAt'>) => fetch(`/api/trends/profiles/${profileId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
}).then(readJson<TrendProfile>)
export const getMemory = (signal: AbortSignal) => fetch(`/api/trends/memory?profileId=${profileId}`, { signal }).then(readJson<MemoryState>)
export const loadHistory = (id: string) => fetch(`/api/trends/profiles/${profileId}/history/${encodeURIComponent(id)}`).then(readJson<TrendReport>)
export const sendFeedback = (url: string, verdict: 'useful' | 'not_useful') => fetch('/api/trends/feedback', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, url, verdict }),
}).then(readJson<{ saved: boolean }>)

export const getModuleContexts = (signal: AbortSignal) => fetch(`/api/trends/profiles/${profileId}/modules`, { signal }).then(readJson<UserModuleContext[]>)
export const saveModuleContext = (value: Omit<UserModuleContext, 'updatedAt'>, signal: AbortSignal) => fetch(`/api/trends/profiles/${profileId}/modules`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal,
}).then(readJson<UserModuleContext>)

/** NDJSON keeps tool progress visible and propagates fetch cancellation to the server. */
export async function streamResearch(request: TrendRequest, signal: AbortSignal, onProgress: (progress: import('../../../../shared/trends').ResearchProgress) => void): Promise<TrendReport> {
  const response = await fetch('/api/trends/research/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  if (!response.ok) return readJson<TrendReport>(response)
  if (!response.body) throw new Error('Поток исследования недоступен')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', report: TrendReport | null = null, bytes = 0
  function receive(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as import('../../../../shared/trends').ResearchStreamEvent
    if (event.type === 'progress') onProgress(event.progress)
    else if (event.type === 'result') report = event.report
    else if (event.type === 'error') throw new Error(event.error)
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 8_000_000) throw new Error('Ответ исследования слишком большой')
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) { receive(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1) }
    }
    buffer += decoder.decode()
    receive(buffer)
    if (!report) throw new Error('Связь прервалась до получения итогового обзора')
    return report
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
