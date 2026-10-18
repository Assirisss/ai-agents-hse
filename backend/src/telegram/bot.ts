import { readLimitedText } from '../trends/http.js'

/** Minimal Telegram Bot API client with long polling: works locally without a public URL or webhook. */

export type TelegramChatInfo = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string }
export type TelegramUser = { id: number; is_bot?: boolean }
export type TelegramMessage = { message_id: number; chat: TelegramChatInfo; text?: string; from?: TelegramUser; photo?: { file_id: string; file_size?: number }[] }
export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: { id: string; data?: string; message?: TelegramMessage; from?: TelegramUser }
}
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string }
export type SendOptions = { html?: boolean; buttons?: InlineButton[][] }

export class TelegramError extends Error {
  constructor(message: string, readonly code: number) { super(message) }
}

export const escapeHtml = (value: string) => value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
export const chatTitle = (chat: TelegramChatInfo) => chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : `Чат ${chat.id}`)

export class TelegramBot {
  constructor(private token: string, private fetcher: typeof fetch = fetch, private baseUrl = 'https://api.telegram.org') {}

  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 20000, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = JSON.parse(await readLimitedText(response, 4_000_000) || '{}') as { ok?: boolean; result?: T; description?: string; error_code?: number }
    if (!data.ok) throw new TelegramError(data.description || `Telegram ответил HTTP ${response.status}`, data.error_code || response.status)
    return data.result as T
  }

  getMe() { return this.call<{ id: number; username: string; first_name: string }>('getMe') }

  /** Long messages are split on line breaks to stay under the 4096-character limit. */
  async send(chatId: string, text: string, options: SendOptions = {}) {
    const chunks: string[] = []
    let current = ''
    for (const line of text.split('\n')) {
      if (current && current.length + line.length + 1 > 3800) { chunks.push(current); current = '' }
      current = current ? `${current}\n${line}` : line.slice(0, 3800)
    }
    if (current) chunks.push(current)
    let last: TelegramMessage | null = null
    for (const [index, chunk] of chunks.entries()) {
      last = await this.call<TelegramMessage>('sendMessage', {
        chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true },
        ...(options.html ? { parse_mode: 'HTML' } : {}),
        ...(options.buttons && index === chunks.length - 1 ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
      })
    }
    return last
  }

  edit(chatId: string, messageId: number, text: string, options: SendOptions = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true }, ...(options.html ? { parse_mode: 'HTML' } : {}), reply_markup: { inline_keyboard: options.buttons || [] } })
  }

  answerCallback(id: string, text?: string) { return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) }) }
  setCommands(commands: { command: string; description: string }[]) { return this.call('setMyCommands', { commands }) }

  /** Poll until the signal aborts. A webhook left from elsewhere is removed once; network errors back off. */
  async poll(onUpdate: (update: TelegramUpdate) => Promise<void>, signal: AbortSignal, onError: (error: Error | null) => void) {
    let offset = 0
    let delay = 1000
    let webhookRemoved = false
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000, signal)
        onError(null)
        delay = 1000
        for (const update of updates) {
          offset = update.update_id + 1
          await onUpdate(update).catch(() => undefined)
        }
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof TelegramError && error.code === 409 && !webhookRemoved) { webhookRemoved = true; await this.call('deleteWebhook').catch(() => undefined); continue }
        if (error instanceof TelegramError && error.code === 401) { onError(new Error('Telegram не принял токен бота')); break }
        onError(error instanceof TelegramError && error.code === 409 ? new Error('Этот бот уже получает сообщения в другой программе. Остановите её или создайте отдельного бота.') : error instanceof Error ? error : new Error('Ошибка Telegram'))
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30000)
      }
    }
  }
}

export type TelegramContext = {
  bot: TelegramBot
  chatId: string
  chat: TelegramChatInfo
  text: string
  /** Text after the command, e.g. `/add купить хлеб` → `купить хлеб`. */
  args: string
  messageId: number | null
  reply: (text: string, options?: SendOptions) => Promise<unknown>
}
export type CallbackContext = TelegramContext & { data: string; answer: (text?: string) => Promise<unknown>; edit: (text: string, options?: SendOptions) => Promise<unknown> }
type Handler<T> = (context: T) => Promise<void>

/** Shared router: each module registers its commands, button prefixes and, at most one, free-text handler. */
export class TelegramRouter {
  private interceptors: ((update: TelegramUpdate) => Promise<boolean>)[] = []
  /** Module routes may claim a raw update before the default command/text handler. */
  intercept(handler: (update: TelegramUpdate) => Promise<boolean>) { this.interceptors.push(handler); return this }
  private commands = new Map<string, { description: string; handler: Handler<TelegramContext> }>()
  private callbacks: { prefix: string; handler: Handler<CallbackContext> }[] = []
  private fallback: Handler<TelegramContext> | null = null

  command(name: string, description: string, handler: Handler<TelegramContext>) { this.commands.set(name.toLowerCase(), { description, handler }); return this }
  callback(prefix: string, handler: Handler<CallbackContext>) { this.callbacks.push({ prefix, handler }); return this }
  text(handler: Handler<TelegramContext>) { this.fallback = handler; return this }
  commandList() { return [...this.commands].filter(([name]) => name !== 'start').map(([command, item]) => ({ command, description: item.description })) }

  async dispatch(bot: TelegramBot, update: TelegramUpdate) {
    for (const handler of this.interceptors) if (await handler(update)) return
    if (update.callback_query) {
      const query = update.callback_query
      const message = query.message
      if (!message || !query.data) { await bot.answerCallback(query.id); return }
      const route = this.callbacks.find((item) => query.data!.startsWith(item.prefix))
      const chatId = String(message.chat.id)
      const context: CallbackContext = {
        bot, chatId, chat: message.chat, text: message.text || '', args: '', messageId: message.message_id, data: query.data,
        reply: (text, options) => bot.send(chatId, text, options), answer: (text) => bot.answerCallback(query.id, text),
        edit: (text, options) => bot.edit(chatId, message.message_id, text, options),
      }
      if (!route) { await context.answer('Кнопка устарела'); return }
      try { await route.handler(context) } catch { await context.answer('Не удалось выполнить действие').catch(() => undefined) }
      return
    }
    const message = update.message
    if (!message?.text) return
    const chatId = String(message.chat.id)
    const context: TelegramContext = { bot, chatId, chat: message.chat, text: message.text, args: '', messageId: message.message_id, reply: (text, options) => bot.send(chatId, text, options) }
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(message.text.trim())
    try {
      if (command) {
        const route = this.commands.get(command[1].toLowerCase())
        if (route) await route.handler({ ...context, args: (command[2] || '').trim() })
        else await context.reply('Не знаю такой команды. Список команд — /help')
      } else if (this.fallback) await this.fallback(context)
    } catch (error) {
      await context.reply(`Ошибка: ${error instanceof Error ? error.message.slice(0, 300) : 'не удалось обработать сообщение'}`).catch(() => undefined)
    }
  }
}
