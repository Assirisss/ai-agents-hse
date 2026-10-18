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
