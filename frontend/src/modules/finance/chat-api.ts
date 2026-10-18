import type { FinanceChatEvent, FinanceChatProgress, FinanceChatRequest, FinanceChatResult, FinanceConversation, FinanceConversationSummary } from '../../../../shared/finance'
import { financeRequest, financeUrl } from './api'

export const listConversations = (signal: AbortSignal) => financeRequest<FinanceConversationSummary[]>('/chat/conversations', signal)
export const createConversation = (signal: AbortSignal) => financeRequest<FinanceConversation>('/chat/conversations', signal, 'POST', {})
export const loadConversation = (id: string, signal: AbortSignal) => financeRequest<FinanceConversation>(`/chat/conversations/${encodeURIComponent(id)}`, signal)

export class FinanceChatError extends Error {
  readonly conflict: boolean
  constructor(message: string, conflict = false) { super(message); this.name = 'FinanceChatError'; this.conflict = conflict }
}

export async function sendChatMessage(id: string, request: FinanceChatRequest, signal: AbortSignal, onProgress: (progress: FinanceChatProgress) => void): Promise<FinanceChatResult> {
  const response = await fetch(financeUrl(`/chat/conversations/${encodeURIComponent(id)}/messages/stream`), { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  if (!response.ok) {
    const value = await response.json().catch(() => null)
    throw new FinanceChatError(value?.error || `Не удалось отправить сообщение (${response.status}).`, response.status === 409)
  }
  if (!response.body) throw new Error('Сервер не открыл поток ответа. Обновите диалог перед повтором.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', result: FinanceChatResult | null = null
  function consume(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as FinanceChatEvent
    if (event.type === 'progress') onProgress(event.progress)
    else if (event.type === 'result') result = event.result
    else if (event.type === 'error') throw new FinanceChatError(event.error, event.conflict)
  }
  try {
    while (true) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      const lines = pending.split('\n'); pending = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (chunk.done) break
    }
    consume(pending)
    if (!result) throw new Error('Связь оборвалась до завершения ответа. Обновите диалог или повторите это сообщение.')
    return result
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
