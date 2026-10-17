import type { TrendCapabilities, TrendReport, TrendRequest } from '../../../../shared/trends'

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error || 'Служба поиска недоступна. Проверьте, что backend запущен.')
  return data as T
}

export const getCapabilities = (signal: AbortSignal) => fetch('/api/trends/capabilities', { signal }).then(readJson<TrendCapabilities>)
export const researchTrends = (request: TrendRequest, signal: AbortSignal) => fetch('/api/trends/research', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
}).then(readJson<TrendReport>)
