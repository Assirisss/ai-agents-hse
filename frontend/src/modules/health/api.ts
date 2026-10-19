import type { HealthAiInput, HealthAiReply, HealthCapabilities, HealthCollection, HealthSettings, HealthState } from '../../../../shared/health'
const base = '/api/sport'
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try { response = await fetch(`${base}${path}`, { method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }) }
  catch (error) { if (signal?.aborted) throw error; throw new Error('Сервер недоступен. Проверьте подключение и запуск backend.') }
  const data = await response.json().catch(() => null)
  if (!response.ok || data === null) throw new Error(data?.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.')
  return data as T
}
export const healthApi = {
  state: (signal?: AbortSignal) => request<HealthState>('/state', 'GET', undefined, signal),
  save: <T>(kind: HealthCollection, body: unknown, id?: string) => request<T>(`/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, id ? 'PUT' : 'POST', body),
  remove: (kind: HealthCollection, id: string) => request(`/${kind}/${encodeURIComponent(id)}`, 'DELETE'),
  settings: (value: HealthSettings) => request<HealthSettings>('/settings', 'PUT', value),
  capabilities: (signal?: AbortSignal) => request<HealthCapabilities>('/capabilities', 'GET', undefined, signal),
  assistant: (input: HealthAiInput, signal: AbortSignal) => { const { operation, ...body } = input; return request<HealthAiReply>(`/assistant/${operation}`, 'POST', body, signal) },
  photo: (id: string, version: string | null) => `${base}/meals/${encodeURIComponent(id)}/photo?v=${encodeURIComponent(version ?? '')}`,
}
