import type { TelegramService } from '../telegram/service.js'
import type { TelegramUpdate as SharedUpdate } from '../telegram/bot.js'
import type { FinanceTelegramBot, FinanceTelegramPort, TelegramUpdate } from './telegram.js'

/** Keep one polling owner; finance receives only its commands, links and conversations. */
export function registerSharedFinance(telegram: TelegramService, bot: FinanceTelegramBot, port: FinanceTelegramPort, planningLinked: (chatId: string) => boolean = () => false) {
  const commands = [['finance', 'Финансы: сообщение или помощь'], ['income', 'Добавить доход'], ['expense', 'Добавить расход'], ['transfer', 'Перевод между счетами'], ['accounts', 'Финансовые счета'], ['categories', 'Категории доходов и расходов'], ['drafts', 'Финансовые черновики'], ['balance', 'Остатки на счетах'], ['expenses', 'Расходы за месяц'], ['period', 'Доходы и расходы за период'], ['operations', 'История операций'], ['summary', 'Сводка котировок']] as const
  for (const [command, description] of commands) {
    telegram.router.command(command, description, async context => { await context.reply('Для финансов используйте /finance. Привязка — в настройках финансов на сайте.') })
  }
  telegram.router.intercept(async (update: SharedUpdate) => {
    const callback = update.callback_query
    const message = callback?.message || update.message
    if (!message) return false
    const text = message.text?.trim() || ''
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
    const name = command?.[1]?.toLowerCase()
    const args = command?.[2]?.trim() || ''
    const financeLink = name === 'start' && (/^fin_/i.test(args) || /^[a-f0-9]{24}$/i.test(args))
    const financeCallback = Boolean(callback?.data && /^(confirm|cancel|edit):[\w-]{1,48}(?::\d{1,16})?$/.test(callback.data))
    let claimed = financeLink || financeCallback || commands.some(([command]) => command === name)
    if (!claimed && !callback && message.from && message.chat.type === 'private' && message.from.id === message.chat.id) {
      const binding = await port.bindingForUser(String(message.from.id), String(message.chat.id))
      if (binding) {
        const pending = await port.pendingDraft(binding.profileId)
        const fieldEdit = /^(?:\/edit\s+)?(?:сумма|дата|сч[её]т|категория|описание|тип|получатель)(?:\s|[:=])/iu.test(text)
        const moneyIntent = /(?:потратил[аи]?|расход|доход|заработал[аи]?|получил[аи]?\s+\d).*\d|\d[\s\S]*(?:руб(?:лей|ля|ль)?|₽)|(?:баланс|остат(?:ок|ки|ков)|расходы|доходы|статистика\s+финанс)/iu.test(text)
        const draftFollowup = Boolean(pending && (/^(?:(?:сегодня|вчера|позавчера|\d{4}-\d{2}-\d{2})[,;\s]+)?(?:с|со|на|в)\s+[^\d]+$/iu.test(text) || /^(?:сегодня|вчера|позавчера|\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d{1,2})?)$/iu.test(text)))
        const filterFollowup = /^(?:(?:а\s+)?за\s+(?:прошл[а-яё]*|предыдущ[а-яё]*|эт[а-яё]*|текущ[а-яё]*)\s+(?:месяц|недел)[а-яё]*|только\s+по\s+[^\d]+)[?!.]*$/iu.test(text)
        const conversationFollowup = !command && filterFollowup && Boolean(await port.hasConversation?.(binding.profileId))
        const financeWelcome = name === 'start' && !args && !planningLinked(String(message.chat.id))
        claimed = Boolean(financeWelcome || message.photo?.length || pending && (name === 'cancel' || name === 'edit' || fieldEdit) || draftFollowup || conversationFollowup || !command && (!planningLinked(String(message.chat.id)) || moneyIntent))
      }
    }
    if (!claimed) return false
    // Finance validates sender ownership again; missing senders are never inferred from chat IDs.
    const forwarded = update as TelegramUpdate
    if (name === 'finance' && update.message) await bot.handleUpdate({ ...forwarded, message: { ...update.message, text: args || '/help' } })
    else await bot.handleUpdate(forwarded)
    return true
  })
}
