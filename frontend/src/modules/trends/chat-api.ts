import type { TrendConversation, TrendConversationSummary, TrendChatRequest, TrendChatResult, TrendChatProgress, TrendChatEvent, TrendChatToolInfo } from '../../../../shared/trend-chat'
const base = '/api/trends/chat/default/conversations'
async function json<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null)
  if (!response.ok || !value) throw new Error(value?.error || 'Чат недоступен. Проверьте backend.')
  return value as T
}
export const listConversations = (signal: AbortSignal) => fetch(base, { signal }).then(json<TrendConversationSummary[]>)
export const loadConversation = (id: string, signal: AbortSignal) => fetch(`${base}/${encodeURIComponent(id)}`, { signal }).then(json<TrendConversation>)
export const createConversation = (reportId?: string, signal?: AbortSignal) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId }), signal }).then(json<TrendConversation>)
export const getChatTools = (signal: AbortSignal) => fetch('/api/trends/chat/tools', { signal }).then(json<TrendChatToolInfo[]>)
export async function sendChatMessage(id: string, request: TrendChatRequest, signal: AbortSignal, onProgress: (progress: TrendChatProgress) => void): Promise<TrendChatResult> {
  const response = await fetch(`${base}/${encodeURIComponent(id)}/messages/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  if (!response.ok) return json<TrendChatResult>(response)
  if (!response.body) throw new Error('Не удалось открыть поток чата')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', size = 0, result: TrendChatResult | null = null
  function receive(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as TrendChatEvent
    if (event.type === 'progress') onProgress(event.progress)
    else if (event.type === 'result') result = event.result
    else if (event.type === 'error') throw new Error(event.error)
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 8_000_000) throw new Error('Ответ чата слишком большой')
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) { receive(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1) }
    }
    receive(buffer + decoder.decode())
    if (!result) throw new Error('Связь прервалась. Обновите диалог или повторите это сообщение.')
    return result
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
