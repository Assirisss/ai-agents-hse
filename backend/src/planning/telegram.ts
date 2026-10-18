import type { AssistantTurn, PlanningDraft } from '../../../shared/planning.js'
import { escapeHtml, chatTitle, type TelegramContext } from '../telegram/bot.js'
import type { TelegramService } from '../telegram/service.js'
import { isOverdue, taskDueDate, taskLine, weekText } from './agenda.js'
import { PlanningError } from './schema.js'
import type { PlanningService } from './service.js'
import { draftText } from './text.js'
import { addDays } from './time.js'

/** Planning commands for the shared bot. Every handler requires a chat linked by a one-time code. */
export function registerPlanningCommands(telegram: TelegramService, service: PlanningService) {
  const store = service.store
  // Chat → draft waiting for a clarification; the next message is appended to the original request.
  const pending = new Map<string, { draftId: string; text: string; expires: number; force: boolean }>()
  const profileOf = async (context: TelegramContext) => {
    const profileId = store.chatProfile(context.chatId)
    if (!profileId) await context.reply('Этот чат ещё не привязан. Откройте на сайте «Дела и календарь» → «Подключения» → Telegram и нажмите «Привязать чат».')
    return profileId
  }
  const html = (text: string) => { const [first, ...rest] = text.split('\n'); return `<b>${escapeHtml(first)}</b>\n${escapeHtml(rest.join('\n'))}` }

  const draftButtons = (draft: PlanningDraft, incomplete: boolean) => ({ buttons: [[...(incomplete ? [] : [{ text: '✅ Сохранить', callback_data: `pl:ok:${draft.id}` }]), { text: '✖ Отмена', callback_data: `pl:no:${draft.id}` }]] })
  // Recent turns per chat, so that «да» or «а на четверг?» reach the agent with context. Kept in memory only.
  const history = new Map<string, { turns: AssistantTurn[]; expires: number }>()
  const remember = (chatId: string, user: string, answer: string) => {
    const current = history.get(chatId)
    const turns = [...(current && current.expires > Date.now() ? current.turns : []), { role: 'user' as const, content: user }, { role: 'assistant' as const, content: answer.slice(0, 1500) }].slice(-6)
    history.set(chatId, { turns, expires: Date.now() + 30 * 60000 })
  }

  /** Draft pipeline: rules first, model only for complex phrases; an incomplete draft waits for a follow-up. */
  const handleDraft = async (context: TelegramContext, raw: string, forceModel = false) => {
    const profileId = await profileOf(context)
    if (!profileId) return
    if (!raw.trim()) { await context.reply('Напишите, что запланировать: например, «завтра в 15 созвон с бухгалтером» или «оплатить аренду до 25-го».'); return }
    const waiting = pending.get(context.chatId)
    pending.delete(context.chatId)
    const text = waiting && waiting.expires > Date.now() ? `${waiting.text} ${raw}` : raw
    if (waiting) store.deleteDraft(profileId, waiting.draftId)
    const force = forceModel || Boolean(waiting?.force && waiting.expires > Date.now())
    await context.bot.call('sendChatAction', { chat_id: context.chatId, action: 'typing' }).catch(() => undefined)
    const draft = await service.createDraft(profileId, { text: text.slice(0, 1000), force })
    const timeZone = store.settings(profileId).timeZone
    const incomplete = draft.items.some((item) => item.missing.length)
    if (incomplete) pending.set(context.chatId, { draftId: draft.id, text, expires: Date.now() + 30 * 60000, force })
    await context.reply(`${draftText(draft, timeZone)}${incomplete ? '\n\nОтветьте следующим сообщением — я дополню запрос.' : ''}`, draftButtons(draft, incomplete))
  }

  /** Free text: a clarification of a pending draft, otherwise the assistant (dispatcher + agent). */
  const handleText = async (context: TelegramContext, raw: string, mode: 'auto' | 'agent' = 'auto') => {
    const profileId = await profileOf(context)
    if (!profileId) return
    const waiting = pending.get(context.chatId)
    if (mode === 'auto' && waiting && waiting.expires > Date.now()) { await handleDraft(context, raw); return }
    if (!raw.trim()) { await context.reply('Спросите, например: «что у меня завтра?», «когда я свободен на 2 часа?» или «распланируй подготовку к экзамену: 6 часов до пятницы».'); return }
    await context.bot.call('sendChatAction', { chat_id: context.chatId, action: 'typing' }).catch(() => undefined)
    const past = history.get(context.chatId)
    const reply = await service.ask(profileId, { message: raw.slice(0, 1000), mode, history: past && past.expires > Date.now() ? past.turns : [] })
    remember(context.chatId, raw, reply.answer)
    if (!reply.draft) { await context.reply(reply.answer); return }
    const incomplete = reply.draft.items.some((item) => item.missing.length)
    if (incomplete && reply.route === 'draft') pending.set(context.chatId, { draftId: reply.draft.id, text: raw, expires: Date.now() + 30 * 60000, force: false })
    const body = reply.route === 'agent' ? `${reply.answer}\n\n${draftText(reply.draft, store.settings(profileId).timeZone)}` : reply.answer
    await context.reply(`${body}${incomplete ? '\n\nОтветьте следующим сообщением — я дополню запрос.' : ''}`, draftButtons(reply.draft, incomplete))
  }

  telegram.router
    .command('start', 'Начать', async (context) => {
      if (context.args) {
        const profileId = store.consumeLinkCode(context.args)
        if (!profileId) { await context.reply('Код привязки устарел или уже использован. Получите новый на сайте.'); return }
        store.linkChat(context.chatId, profileId, chatTitle(context.chat))
        await context.reply(`Чат привязан ✓\n\nБуду присылать план на день и напоминания. Просто напишите, что запланировать, или используйте /today, /week, /tasks.\n\n${service.brief(profileId).text}`)
        return
      }
      if (store.chatProfile(context.chatId)) await context.reply('Я на связи. Напишите, что запланировать, или выберите команду: /today, /tomorrow, /week, /tasks, /help')
      else await profileOf(context)
    })
    .command('today', 'План на сегодня', async (context) => {
      const profileId = await profileOf(context)
      if (profileId) await context.reply(html(service.brief(profileId).text), { html: true })
    })
    .command('tomorrow', 'План на завтра', async (context) => {
      const profileId = await profileOf(context)
      if (profileId) await context.reply(html(service.brief(profileId, addDays(service.today(profileId), 1)).text), { html: true })
    })
    .command('week', 'План на 7 дней', async (context) => {
      const profileId = await profileOf(context)
      if (profileId) await context.reply(html(weekText(service.agenda(profileId), store.settings(profileId).timeZone)), { html: true })
    })
    .command('tasks', 'Открытые задачи', async (context) => {
      const profileId = await profileOf(context)
      if (!profileId) return
      const timeZone = store.settings(profileId).timeZone
      const now = service.now()
      const open = service.tasks(profileId).filter((task) => task.status === 'open')
        .sort((a, b) => Number(isOverdue(b, now, timeZone)) - Number(isOverdue(a, now, timeZone)) || (taskDueDate(a, timeZone) || '9999').localeCompare(taskDueDate(b, timeZone) || '9999') || a.priority - b.priority)
      if (!open.length) { await context.reply('Открытых задач нет 🎉'); return }
      const shown = open.slice(0, 15)
      await context.reply([`Открытые задачи (${open.length}):`, ...shown.map((task) => `${isOverdue(task, now, timeZone) ? '⏰' : '☐'} ${taskLine(task, timeZone, true)}`), open.length > shown.length ? `…и ещё ${open.length - shown.length} на сайте` : ''].filter(Boolean).join('\n'), {
        buttons: shown.slice(0, 8).map((task) => [{ text: `✓ ${task.title.slice(0, 40)}`, callback_data: `pl:done:${task.id}` }]),
      })
    })
    .command('add', 'Добавить дело текстом', async (context) => handleDraft(context, context.args))
    .command('ask', 'Спросить агента', async (context) => {
      if (!service.agentModel) { await context.reply('Модель не настроена на сервере — агент недоступен, но простые вопросы и добавление дел работают.'); return }
      await handleText(context, context.args, 'agent')
    })
    .command('ai', 'Разобрать текст моделью', async (context) => {
      if (!service.extractor.modelInfo) { await context.reply('Модель не настроена на сервере — сейчас работают только правила.'); return }
      await handleDraft(context, context.args, true)
    })
    .command('sync', 'Синхронизировать календари', async (context) => {
      const profileId = await profileOf(context)
      if (!profileId) return
      await service.syncDue(profileId, true)
      const accounts = service.accounts(profileId)
      await context.reply(accounts.length ? accounts.map((account) => `${account.provider === 'google' ? 'Google' : 'Яндекс'} (${account.label}): ${account.status === 'ok' ? 'синхронизировано ✓' : account.lastError || 'ошибка'}`).join('\n') : 'Внешние календари не подключены. Их можно добавить на сайте.')
    })
    .command('unlink', 'Отвязать этот чат', async (context) => {
      store.unlinkChat(context.chatId)
      await context.reply('Чат отвязан. Уведомления больше не придут.')
    })
    .command('help', 'Что умеет бот', async (context) => {
      await context.reply(['Напишите обычным текстом, например:', '• завтра в 15 созвон с бухгалтером', '• оплатить аренду до 25-го', '• что у меня завтра?', '• когда я свободен на 2 часа?', '• распланируй подготовку к экзамену: 6 часов до пятницы', '', 'Если правила поняли не так — /ai текст: разберёт модель.', '', 'Команды:', ...telegram.router.commandList().map((item) => `/${item.command} — ${item.description}`)].join('\n'))
    })
    .text((context) => handleText(context, context.text))
    .callback('pl:', async (context) => {
      const profileId = store.chatProfile(context.chatId)
      if (!profileId) { await context.answer('Чат не привязан'); return }
      const [, action, id] = context.data.split(':')
      try {
        if (action === 'ok') {
          const draft = service.draft(profileId, id)
          const result = service.confirmDraft(profileId, id)
          pending.delete(context.chatId)
          await context.edit(`${draftText(draft, store.settings(profileId).timeZone)}\n\nСохранено ✓ (${result.created.events.length} соб., ${result.created.tasks.length} зад.)`)
          await context.answer('Сохранено')
        } else if (action === 'no') {
          service.cancelDraft(profileId, id)
          pending.delete(context.chatId)
          await context.edit('Отменено.')
          await context.answer()
        } else if (action === 'done') {
          const { task, next } = service.completeTask(profileId, id)
          await context.answer(`Готово: ${task.title}`)
          if (next) await context.reply(`Следующий срок «${next.title}»: ${next.due ? taskLine(next, store.settings(profileId).timeZone, true) : '—'}`)
        } else await context.answer('Неизвестное действие')
      } catch (error) {
        await context.answer(error instanceof PlanningError ? error.message : 'Не удалось выполнить действие')
      }
    })
}
