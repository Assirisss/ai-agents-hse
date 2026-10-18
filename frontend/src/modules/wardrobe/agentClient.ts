import type { WardrobeAgentCapabilities, WardrobeAgentEvent, WardrobeAgentProgress, WardrobeAgentReply, WardrobeChatMessage, WardrobeChatRequest, WardrobeSnapshot } from '../../../../shared/wardrobe-agent'
import type { WardrobeRepository } from './types'
import type { WardrobeClientCall, WardrobeClientResult } from '../../../../shared/wardrobe-tools'

export async function readAgentSnapshot(repository: WardrobeRepository): Promise<WardrobeSnapshot> {
  const [garments, outfits, wears, wishlist] = await Promise.all([repository.list(), repository.listOutfits(), repository.listWearEvents(), repository.listWishlist()])
  return {
    // Explicit projection: Blob, photos, object URLs and hidden record fields are never serialized.
    garments: garments.slice(0, 500).map(({ id, name, category, color, season, brand, notes, updatedAt }) => ({ id, name, category, color, season, brand, notes, updatedAt })),
    outfits: outfits.slice(0, 250).map(({ id, name, notes, layers, updatedAt }) => ({ id, name, notes, garmentIds: layers.map(layer => layer.garmentId), updatedAt })),
    wears: wears.slice(0, 2000).map(({ date, outfitId, garments }) => ({ date, outfitId, garmentIds: garments.map(item => item.id) })),
    wishlist: wishlist.slice(0, 250).map(({ id, name, category, priceMinor, currency, priority, url, notes, status }) => ({ id, name, category, priceMinor, currency, priority, url, notes, status })),
    totals: { garments: garments.length, outfits: outfits.length, wears: wears.length, wishlist: wishlist.length },
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(body?.error || 'Стилист недоступен. Проверьте подключение и запуск backend.')
  return body as T
}
export const getStylistCapabilities = (signal: AbortSignal) => fetch('/api/wardrobe/agent/capabilities', { signal }).then(json<WardrobeAgentCapabilities>)
export async function askStylist(request: WardrobeChatRequest, signal: AbortSignal, onProgress?: (progress: WardrobeAgentProgress) => void, execute?: (call: WardrobeClientCall, signal: AbortSignal) => Promise<WardrobeClientResult>): Promise<WardrobeAgentReply> {
  const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(925000)])
  const response = await fetch('/api/wardrobe/agent/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeSignal, body: JSON.stringify(request),
  })
  if (!response.ok) return json<WardrobeAgentReply>(response)
  if (!response.body) throw new Error('Сервер не открыл поток ответа.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let result: WardrobeAgentReply | undefined
  const consume = async (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as WardrobeAgentEvent
    if (event.type === 'progress') onProgress?.(event.progress)
    else if (event.type === 'result') result = event.reply
    else if (event.type === 'error') throw new Error(event.error)
    else if (event.type === 'tool_request') {
      let outcome: WardrobeClientResult
      try {
        if (!execute) throw new Error('Браузерный инструмент не подключён. Обновите страницу.')
        outcome = await execute(event.call, activeSignal)
      } catch (cause) {
        if (activeSignal.aborted) throw cause
        outcome = { ok: false, error: (cause instanceof Error ? cause.message : 'Ошибка инструмента').slice(0, 1200) }
      }
      activeSignal.throwIfAborted()
      await json(await fetch(`/api/wardrobe/agent/tool-results/${encodeURIComponent(event.token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeSignal, body: JSON.stringify({ callId: event.call.id, result: outcome }) }))
    }
  }
  try {
    while (true) {
      activeSignal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 1_000_000) throw new Error('Ответ стилиста слишком большой.')
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { await consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
    }
    buffer += decoder.decode()
    await consume(buffer)
    if (!result) throw new Error('Ответ стилиста прервался. Уже добавленные фотографии остаются в гардеробе; попробуйте снова.')
    return result
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function conversationHistory(messages: WardrobeChatMessage[]): WardrobeChatRequest['history'] {
  return messages.slice(-20).map(message => ({ role: message.role, content: (message.text + (message.attachments?.length ? '\nИзображения: ' + JSON.stringify(message.attachments) : '') + (message.receipts?.length ? '\nФактически выполнено платформой: ' + JSON.stringify(message.receipts) : '') + (message.reply?.actions.length ? '\nКарточки платформы: ' + JSON.stringify(message.reply.actions.map(action => ({ ...action, result: message.results?.[action.id] ?? { status: 'not_applied' } }))) : '')).slice(0, 6000) }))
}

export const traceLabels: Record<string, string> = {
  wardrobe_search: 'Поиск вещей', wardrobe_outfits: 'Чтение образов', wardrobe_statistics: 'Статистика носки', wardrobe_wishlist: 'Список желаний',
  wardrobe_prepare_outfit: 'Подготовка образа', wardrobe_prepare_purchase: 'Подготовка покупки', wardrobe_prepare_garment: 'Добавление вещи',
  wardrobe_prepare_update: 'Изменение вещи', wardrobe_prepare_wear: 'Отметка носки', wardrobe_search_trends: 'Обращение к агенту трендов', wardrobe_finish: 'Ответ готов',
  wardrobe_inspect_photo: 'Распознаёт вещь на фото', wardrobe_save_photo: 'Добавляет вещь в гардероб',
  wardrobe_inspect_image: 'Рассматриваю фотографию', wardrobe_add_from_image: 'Добавляю вещь в гардероб', wardrobe_remove_background: 'Убираю фон', wardrobe_update_garment: 'Обновляю описание вещи', wardrobe_replace_photo: 'Меняю фотографию вещи',
}

export function readChat(key: string): WardrobeChatMessage[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw || raw.length > 500000) return []
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.messages)) return []
    return data.messages.filter((message: WardrobeChatMessage) => typeof message.id === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && message.text.length <= 6000 && (!message.reply || (Array.isArray(message.reply.actions) && message.reply.actions.every(action => typeof action.id === 'string' && ['outfit', 'purchase', 'garment', 'update', 'wear'].includes(action.kind)) && Array.isArray(message.reply.sources) && Array.isArray(message.reply.trace) && Array.isArray(message.reply.warnings)))).slice(-40)
  } catch { return [] }
}

export async function persistChat(key: string, messages: WardrobeChatMessage[]) {
  const recent = messages.slice(-40)
  let serialized = JSON.stringify({ version: 1, messages: recent })
  while (serialized.length > 450000 && recent.length > 1) {
    recent.shift()
    serialized = JSON.stringify({ version: 1, messages: recent })
  }
  localStorage.setItem(key, serialized)
}
