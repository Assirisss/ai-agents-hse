import type { AgentReply, Draft, DraftInput, FinanceState, MarketSummary, Operation } from '../../../shared/finance.js'
import { moscowDate } from './market.js'
import { formatMoney as money, sumKopecks } from './money.js'
import { FinanceError } from './schema.js'

export interface FinanceTelegramPort {
  claimUpdate(updateId: number): Promise<boolean>
  bindingForUser(userId: string, chatId: string): Promise<{ profileId: string } | null>
  consumeLinkCode(code: string, telegramUserId: string, chatId: string): Promise<boolean>
  state(profileId: string): Promise<FinanceState>
  createTextDraft(profileId: string, text: string): Promise<Draft>
  chat?(profileId: string, text: string, turnId: string): Promise<AgentReply>
  hasConversation?(profileId: string): Promise<boolean>
  createReceiptDraft(profileId: string, file: { filename: string; mime: string; bytes: Uint8Array }): Promise<Draft>
  updateDraft(profileId: string, id: string, patch: DraftInput): Promise<Draft>
  confirmDraft(profileId: string, id: string, expectedRevision: number): Promise<Operation>
  cancelDraft(profileId: string, id: string): Promise<void>
  setPendingDraft(profileId: string, id: string | null): Promise<void>
  pendingDraft(profileId: string): Promise<string | null>
  summary(profileId: string): Promise<MarketSummary>
  getCursor(): Promise<number>
  setCursor(nextOffset: number): Promise<void>
}

type TelegramUser = { id: number; is_bot?: boolean }
type TelegramMessage = { message_id: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string; photo?: { file_id: string; file_size?: number }[] }
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string } }
type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] }

export class TelegramApiError extends Error {
  constructor(message: string, readonly ambiguous: boolean, readonly retryable: boolean, readonly retryAfter?: number) { super(message); this.name = 'TelegramApiError' }
}

/** Tokens never leave this adapter and are excluded from error messages. */
export class TelegramClient {
  private readonly fetcher: typeof fetch
  constructor(private readonly token: string, options: { fetch?: typeof fetch } = {}) {
    if (!/^[\d]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Некорректный токен Telegram')
    this.fetcher = options.fetch ?? fetch
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal, timeout = 20_000): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: 'error' })
    } catch { throw new TelegramApiError('Не удалось подтвердить ответ Telegram', method === 'sendMessage', true) }
    let data: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } }
    try { data = await response.json() as typeof data } catch { throw new TelegramApiError('Некорректный ответ Telegram', method === 'sendMessage', response.status >= 500) }
    if (!response.ok || !data.ok) {
      const code = data.error_code ?? response.status
      throw new TelegramApiError(`Telegram отклонил запрос (${code})`, false, code === 429 || code >= 500, data.parameters?.retry_after)
    }
    return data.result as T
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> { return this.call('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'] }, signal, 35_000) }
  answerCallback(id: string): Promise<unknown> { return this.call('answerCallbackQuery', { callback_query_id: id }) }

  async sendText(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 3900) { const split = remaining.lastIndexOf('\n', 3900); const cut = split > 0 ? split : 3900; chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart() }
    chunks.push(remaining || ' ')
    let sent = 0
    for (const [index, chunk] of chunks.entries()) {
      try { await this.call('sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true }, ...(index === chunks.length - 1 && keyboard ? { reply_markup: keyboard } : {}) }); sent++ }
      catch (error) { if (sent > 0) throw new TelegramApiError('Сводка доставлена частично', true, false); throw error }
    }
  }

  async downloadPhoto(fileId: string): Promise<{ filename: string; mime: string; bytes: Uint8Array }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path || !/^[\w/-]+\.(?:jpe?g|png|webp)$/i.test(file.file_path) || file.file_path.includes('..') || (file.file_size ?? 0) > 10 * 1024 * 1024) throw new Error('Чек должен быть изображением размером до 10 МБ')
    try {
      const response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000), redirect: 'error' })
      if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024 || !response.body) throw new Error('download')
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          size += value.byteLength
          if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error('size') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const extension = file.file_path.split('.').at(-1)?.toLowerCase()
      return { filename: `telegram-receipt.${extension}`, mime: extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg', bytes }
    } catch { throw new Error('Не удалось загрузить изображение из Telegram') }
  }
}

const HELP = 'Добавление без модели:\n/expense 850 продукты; счёт Наличные; дата сегодня\n/income 10000 зарплата; счёт Карта\n/transfer 500; со счёта Карта; на счёт Наличные\n\nДата в этих командах по умолчанию — сегодня. Также можно написать «вчера потратил 850 на продукты с карты» или отправить фото чека. Я покажу черновик; запись появится после кнопки «Подтвердить».\n/accounts — счета\n/categories — категории\n/drafts — черновики\n/balance — остатки\n/expenses — расходы за месяц\n/period прошлый месяц — доходы и расходы\n/summary — котировки MOEX\n/cancel — отменить текущий черновик\n/help — помощь'

function editPatch(text: string, state: FinanceState): DraftInput | null {
  const match = text.match(/^(?:\/edit\s+)?(сумма|дата|сч[её]т|категория|описание|тип|получатель)\s*[:=]?\s+(.+)$/iu)
  if (!match) return null
  const field = match[1]!.toLowerCase(); const value = match[2]!.trim()
  if (field === 'сумма') {
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw new Error('Укажите сумму в рублях, например: сумма 350,50')
    const [rubles, fractional = ''] = value.replace(',', '.').split('.')
    const amount = Number(rubles) * 100 + Number(fractional.padEnd(2, '0'))
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Сумма должна быть положительной')
    return { amount }
  }
  if (field === 'дата') return { date: value }
  if (field === 'описание') return { description: value }
  if (field === 'тип') {
    const kind = ({ доход: 'income', расход: 'expense', перевод: 'transfer' } as const)[value.toLowerCase() as 'доход']
    if (!kind) throw new Error('Тип: доход, расход или перевод')
    return { kind }
  }
  if (field === 'категория') {
    const category = state.categories.find(item => item.id === value || item.name.toLowerCase() === value.toLowerCase())
    if (!category) throw new Error('Категория не найдена')
    return { categoryId: category.id }
  }
  const account = state.accounts.find(item => !item.archived && (item.id === value || item.name.toLowerCase() === value.toLowerCase()))
  if (!account) throw new Error('Счёт не найден')
  return field === 'получатель' ? { destinationAccountId: account.id } : { accountId: account.id }
}

export class FinanceTelegramBot {
  private readonly now: () => Date
  constructor(private readonly port: FinanceTelegramPort, readonly client: TelegramClient, options: { now?: () => Date } = {}) { this.now = options.now ?? (() => new Date()) }

  private async showDraft(profileId: string, chatId: string, draft: Draft): Promise<void> {
    const state = await this.port.state(profileId)
    const names: Record<string, string> = { kind: 'тип', amount: 'сумма', date: 'дата', accountId: 'счёт', categoryId: 'категория', destinationAccountId: 'счёт получателя' }
    const methods = { manual: 'введено вручную', rule: 'разобрано правилом', model: 'предложено моделью', receipt: 'распознано из чека' }
    const provenance = Object.entries(draft.provenance || {}).map(([field, value]) => `${names[field] || field}: ${methods[value.method]}${value.excerpt ? ` · «${value.excerpt.slice(0, 80)}»` : ''}${value.note ? ` · ${value.note}` : ''}`)
    const text = [`Черновик · ${draft.id}`, `Тип: ${draft.kind === 'income' ? 'доход' : draft.kind === 'expense' ? 'расход' : draft.kind === 'transfer' ? 'перевод' : 'не указан'}`, `Сумма: ${draft.amount ? money(draft.amount) : 'не указана'}`, `Дата: ${draft.date ?? 'не указана'}`, `Счёт: ${state.accounts.find(item => item.id === draft.accountId)?.name ?? 'не указан'}`, `Категория: ${state.categories.find(item => item.id === draft.categoryId)?.name ?? 'не указана'}`, ...(draft.kind === 'transfer' ? [`Получатель: ${state.accounts.find(item => item.id === draft.destinationAccountId)?.name ?? 'не указан'}`] : []), `Описание: ${draft.description || '—'}`, ...draft.missing.length ? [`Заполните: ${draft.missing.map(key => names[key] ?? key).join(', ')}`] : [], ...draft.warnings.map(warning => `Внимание: ${warning}`), ...(provenance.length ? ['\nПроисхождение полей:', ...provenance] : []), '\nОперация попадёт в учёт только после подтверждения.'].join('\n')
    const id = draft.id
    const keyboard: Keyboard = { inline_keyboard: [...draft.missing.length ? [] : [[{ text: 'Подтвердить', callback_data: `confirm:${id}:${draft.revision ?? 0}` }]], [{ text: 'Изменить', callback_data: `edit:${id}` }, { text: 'Отменить', callback_data: `cancel:${id}` }]] }
    await this.port.setPendingDraft(profileId, draft.id)
    await this.client.sendText(chatId, text, keyboard)
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!Number.isSafeInteger(update.update_id) || !await this.port.claimUpdate(update.update_id)) return
    const callback = update.callback_query
    const message = callback?.message ?? update.message
    const user = callback?.from ?? message?.from
    if (!message || !user || user.is_bot || message.chat.type !== 'private' || message.chat.id !== user.id) return
    const chatId = String(message.chat.id); const userId = String(user.id)
    try {
      if (callback) {
        await this.client.answerCallback(callback.id).catch(() => undefined)
        const binding = await this.port.bindingForUser(userId, chatId)
        if (!binding) { await this.client.sendText(chatId, 'Сначала привяжите профиль: /start КОД. Код доступен в настройках сайта.'); return }
        const parsed = /^(confirm|cancel|edit):([\w-]{1,48})(?::(\d{1,16}))?$/.exec(callback.data ?? '')
        if (!parsed) return
        const [, action, draftId, revision] = parsed
        const state = await this.port.state(binding.profileId)
        const draft = state.drafts.find(item => item.id === draftId)
        if (!draft || draft.status !== 'pending') { await this.client.sendText(chatId, 'Черновик уже обработан или недоступен.'); return }
        if (action === 'confirm') {
          // Old keyboards have no version; show a fresh preview instead of trusting them.
          try {
            if (revision === undefined || !Number.isSafeInteger(Number(revision)) || Number(revision) !== (draft.revision ?? 0)) throw new FinanceError('Черновик изменился', 409)
            await this.port.confirmDraft(binding.profileId, draft.id, Number(revision))
          } catch (error) {
            if (!(error instanceof FinanceError) || error.statusCode !== 409) throw error
            const latest = (await this.port.state(binding.profileId)).drafts.find(item => item.id === draft.id)
            await this.client.sendText(chatId, 'Черновик изменился или кнопка устарела. Проверьте актуальные поля и подтвердите заново.')
            if (latest?.status === 'pending') await this.showDraft(binding.profileId, chatId, latest)
            return
          }
          await this.client.sendText(chatId, 'Операция сохранена. Баланс обновлён.'); return
        }
        if (action === 'cancel') { await this.port.cancelDraft(binding.profileId, draft.id); await this.port.setPendingDraft(binding.profileId, null); await this.client.sendText(chatId, 'Черновик отменён.'); return }
        await this.port.setPendingDraft(binding.profileId, draft.id)
        await this.client.sendText(chatId, `Отправьте одно изменение:\nсумма 350,50\nдата ${moscowDate(this.now())}\nсчёт Наличные\nкатегория Продукты\nописание Покупка\nтип расход\nполучатель Карта\n\nСчета: ${state.accounts.filter(item => !item.archived).map(item => item.name).join(', ')}\nКатегории: ${state.categories.map(item => item.name).join(', ')}`)
        return
      }
      const text = message.text?.trim() ?? ''
      const parsedCommand = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
      const command = parsedCommand ? `/${parsedCommand[1]!.toLowerCase()}` : undefined
      if (command === '/start') {
        const code = parsedCommand?.[2]?.trim() || ''
        const linked = code && /^[A-Za-z0-9_-]{6,128}$/.test(code) ? await this.port.consumeLinkCode(code, userId, chatId) : false
        if (linked) { await this.client.sendText(chatId, `Профиль привязан.\n${HELP}`); return }
        const binding = await this.port.bindingForUser(userId, chatId)
        if (binding) {
          await this.client.sendText(chatId, `Финансовый профиль уже привязан. Можно пользоваться командами.${code ? '\nПрисланный код не применён. Для смены профиля сначала отключите текущую привязку в настройках финансов на сайте.' : ''}\n${HELP}`)
          return
        }
        await this.client.sendText(chatId, code ? 'Код привязки недействителен, истёк или уже использован. Создайте новый код в настройках финансов на сайте и отправьте /start КОД. Код действует 10 минут.' : 'Получите одноразовый код в настройках финансов на сайте и отправьте /start КОД. Код действует 10 минут.')
        return
      }
      const binding = await this.port.bindingForUser(userId, chatId)
      if (!binding) { await this.client.sendText(chatId, 'Привяжите профиль: /start КОД. Код доступен в настройках сайта.'); return }
      const profileId = binding.profileId
      if (command === '/help') { await this.client.sendText(chatId, HELP); return }
      if (command === '/summary') { await this.client.sendText(chatId, (await this.port.summary(profileId)).text); return }
      if (command === '/cancel') {
        const id = await this.port.pendingDraft(profileId)
        if (id) { await this.port.cancelDraft(profileId, id); await this.port.setPendingDraft(profileId, null) }
        await this.client.sendText(chatId, id ? 'Черновик отменён.' : 'Текущего черновика нет.'); return
      }
      const state = await this.port.state(profileId)
      if (!this.port.chat && command === '/balance') { await this.client.sendText(chatId, state.accounts.filter(item => !item.archived).map(item => `${item.name}: ${money(item.balance)}`).join('\n') || 'Счета пока не добавлены.'); return }
      if (!this.port.chat && command === '/expenses') {
        const today = moscowDate(this.now()); const month = today.slice(0, 7)
        const total = sumKopecks(state.operations.filter(item => item.status === 'posted' && item.kind === 'expense' && item.date.startsWith(month) && item.date <= today).map(item => item.amount))
        await this.client.sendText(chatId, `Расходы за ${month}: ${money(total)}`); return
      }
      if (message.photo?.length) {
        const photo = message.photo.at(-1)!
        if ((photo.file_size ?? 0) > 10 * 1024 * 1024) throw new Error('Изображение должно быть до 10 МБ')
        await this.showDraft(profileId, chatId, await this.port.createReceiptDraft(profileId, await this.client.downloadPhoto(photo.file_id))); return
      }
      if (this.port.chat && text) {
        const result = await this.port.chat(profileId, text, `telegram-update-${update.update_id}`)
        if (result.draft) await this.showDraft(profileId, chatId, result.draft)
        else {
          const ids = new Set(result.evidence?.flatMap(item => item.operationIds) || [])
          const operations = state.operations.filter(item => ids.has(item.id)).sort((a, b) => b.date.localeCompare(a.date))
          const evidence = operations.slice(0, 10).map(item => `${item.date} · ${money(item.amount)} · ${item.description || (item.kind === 'income' ? 'доход' : item.kind === 'expense' ? 'расход' : 'перевод')}`)
          await this.client.sendText(chatId, `${result.text}${evidence.length ? `\n\nОперации в основании:\n${evidence.join('\n')}${operations.length > 10 ? '\nПолный список доступен в истории операций на сайте.' : ''}` : ''}`)
        }
        return
      }
      if (!text || text.startsWith('/') && !text.startsWith('/edit ')) { await this.client.sendText(chatId, HELP); return }
      const pending = await this.port.pendingDraft(profileId)
      if (pending && state.drafts.some(item => item.id === pending && item.status === 'pending')) {
        const patch = editPatch(text, state)
        if (!patch) { await this.client.sendText(chatId, 'Для изменения укажите поле: например «сумма 350» или «категория Продукты». Для нового ввода отмените текущий черновик командой /cancel.'); return }
        await this.showDraft(profileId, chatId, await this.port.updateDraft(profileId, pending, patch)); return
      }
      await this.showDraft(profileId, chatId, await this.port.createTextDraft(profileId, text))
    } catch {
      await this.client.sendText(chatId, 'Не удалось выполнить действие. Проверьте сумму, дату и счёт или откройте черновик на сайте. Простые команды доступны без модели; распознавание фото требует настроенной модели. Операции сохраняются только после подтверждения.').catch(() => undefined)
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    const offset = await this.port.getCursor()
    const updates = await this.client.getUpdates(offset, signal)
    for (const update of updates.sort((a, b) => a.update_id - b.update_id)) { await this.handleUpdate(update); await this.port.setCursor(update.update_id + 1) }
  }
}
