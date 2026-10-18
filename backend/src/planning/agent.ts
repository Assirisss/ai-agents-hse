import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AssistantReply, AssistantRoute, AssistantStep, DraftItem, PlanningDraft, PlanningTask } from '../../../shared/planning.js'
import { freeSlots, isOverdue, taskDueDate, taskLine, weekText } from './agenda.js'
import { parseItem, type ParseContext } from './dateparse.js'
import type { ChatMessage, ToolModel, ToolSpec } from './model.js'
import { assistantRequestSchema, proposalSchema } from './schema.js'
import type { PlanningService } from './service.js'
import { draftText } from './text.js'
import { addDays, atLocalTime, dayRange, daysBetween, formatMinutes, humanDate, isDateKey, localDate, localTime, parseDateKey, weekday, weekdayName } from './time.js'

/**
 * Planning assistant = rule-based dispatcher + bounded tool-using agent.
 * Simple requests (day plan, week, free time, tasks, «завтра в 15 созвон») never reach the model.
 * The agent gets read-only tools and one write-like tool, `propose`, that only creates a draft:
 * code checks dates, working hours and conflicts, and the user saves the draft explicitly.
 */
export const agentBudget = { modelTurns: 8, toolCalls: 14, proposals: 3, durationMs: 150000 } as const

type Request = z.infer<typeof assistantRequestSchema>
type Dispatch = { route: AssistantRoute; reason: string; date?: string; days?: number; minutes?: number }

const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim()
const questionStart = /^(когда|сколько|что|какие|какой|какая|каких|есть ли|покажи|найди|подскажи|где|чем|во сколько|у меня|я свободен|свободен ли)/
const agentVerbs = /(помоги|распланируй|спланируй|предложи|разбей|подбери|организуй|перенеси|оптимизируй|составь|раскидай|распредели|посоветуй|как лучше|что важнее|приоритет|успею ли|уложусь ли)/
const planWords = /(план|расписани|что у меня|какие (дела|события|встречи)|что (запланировано|будет)|чем я занят|занят ли)/

function mentionedDate(text: string, context: ParseContext) {
  const item = parseItem(text, context)
  const value = item.kind === 'event' ? item.start : item.due
  if (!value) return undefined
  return isDateKey(value) ? value : localDate(new Date(value), context.timeZone)
}
function durationOf(text: string) {
  if (/полтора\s+час/.test(text)) return 90
  if (/полчаса/.test(text)) return 30
  const match = /(\d+(?:[.,]\d)?)\s*(час|ч\b|мин)/.exec(text)
  if (match) return Math.round(Number(match[1].replace(',', '.')) * (match[2].startsWith('мин') ? 1 : 60))
  return /\bчас\b|на час/.test(text) ? 60 : undefined
}

/** Ordinary code decides where a request goes; the model is not needed to route it. */
export function dispatch(message: string, context: ParseContext, followUp = false): Dispatch {
  const text = normalize(message)
  const question = text.includes('?') || questionStart.test(text)
  // «да», «давай», «а на четверг?» only make sense together with the previous answer.
  if (followUp && (/^(да|нет|ок|окей|давай|хорошо|сделай|согласен|подходит|не подходит|лучше|а |и |тогда|только|не надо|измени|убери|добавь ещ)/.test(text) || text.split(/\s+/).length <= 2)) return { route: 'agent', reason: 'Продолжение разговора — отвечает агент с учётом истории.' }
  if (agentVerbs.test(text)) return { route: 'agent', reason: 'Просьба спланировать или посоветовать: последовательность шагов заранее неизвестна — нужен агент.' }
  const date = mentionedDate(message, context)
  const today = localDate(context.now, context.timeZone)
  if (/(свобод|окн[оа]\b|окон|найди время|когда (я )?могу|есть (ли )?время)/.test(text)) {
    const week = /недел/.test(text)
    const from = /следующ\S* недел/.test(text) ? addDays(today, 8 - weekday(today)) : date ?? today
    return { route: 'free_slots', reason: 'Поиск свободного времени — расчёт по календарю, без модели.', date: from, days: date && !week ? 1 : week ? 7 : 5, minutes: durationOf(text) ?? 60 }
  }
  if (/(задач|просроч|что (мне )?(нужно|надо) сделать|список дел|мои дела)/.test(text) && (question || /^(задачи|просрочен|мои дела|список)/.test(text))) return { route: 'tasks', reason: 'Список задач — выборка из базы, без модели.' }
  if (/недел/.test(text) && (question || planWords.test(text))) {
    const from = /следующ\S* недел/.test(text) ? addDays(today, 8 - weekday(today)) : today
    return { route: 'week', reason: 'План на неделю — расчёт по календарю, без модели.', date: from }
  }
  if ((question || /^план/.test(text)) && (planWords.test(text) || /(сегодня|завтра|послезавтра|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)/.test(text))) return { route: 'day_plan', reason: 'План на день — расчёт по календарю, без модели.', date: date ?? today }
  if (!question) return { route: 'draft', reason: 'Похоже на новое дело — черновик по правилам.' }
  return { route: 'agent', reason: 'Вопрос не подходит под готовые сценарии — нужен агент.' }
}

function slotsText(service: PlanningService, profileId: string, from: string, days: number, minutes: number) {
  const settings = service.settings(profileId)
  const lines: string[] = []
  for (let index = 0; index < days; index++) {
    const date = addDays(from, index)
    const range = dayRange(date, settings.timeZone)
    const slots = freeSlots(service.occurrences(profileId, range.start, range.end), date, settings, service.now()).slots.filter((slot) => slot.minutes >= minutes)
    if (slots.length) lines.push(`${humanDate(date)}: ${slots.map((slot) => `${localTime(new Date(slot.start), settings.timeZone)}–${localTime(new Date(slot.end), settings.timeZone)}`).join(', ')}`)
  }
  return lines.length ? [`Свободные окна от ${formatMinutes(minutes)} в рабочие часы (${settings.workStart}–${settings.workEnd}):`, ...lines].join('\n') : `Окон от ${formatMinutes(minutes)} в рабочие часы на ${days === 1 ? 'этот день' : `ближайшие ${days} дн.`} нет.`
}

function tasksText(tasks: PlanningTask[], now: Date, timeZone: string) {
  const open = tasks.filter((task) => task.status === 'open')
  if (!open.length) return 'Открытых задач нет.'
  const overdue = open.filter((task) => isOverdue(task, now, timeZone))
  const dated = open.filter((task) => task.due && !isOverdue(task, now, timeZone)).sort((a, b) => (taskDueDate(a, timeZone) || '').localeCompare(taskDueDate(b, timeZone) || ''))
  const undated = open.filter((task) => !task.due)
  return [
    `Открытых задач: ${open.length}.`,
    ...(overdue.length ? ['', `Просрочено (${overdue.length}):`, ...overdue.slice(0, 10).map((task) => `• ${taskLine(task, timeZone, true)}`)] : []),
    ...(dated.length ? ['', 'Со сроком:', ...dated.slice(0, 10).map((task) => `• ${taskLine(task, timeZone, true)}`)] : []),
    ...(undated.length ? ['', `Без срока (${undated.length}):`, ...undated.slice(0, 8).map((task) => `• ${task.title}`)] : []),
  ].join('\n')
}

const repeatRule = (repeat: string | undefined, date: string) => {
  const { day } = parseDateKey(date)
  return { none: null, daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: `FREQ=WEEKLY;BYDAY=${['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][weekday(date) - 1]}`, monthly: `FREQ=MONTHLY;BYMONTHDAY=${day}`, yearly: 'FREQ=YEARLY' }[repeat || 'none'] ?? null
}

type Tool = { description: string; schema: z.ZodType; run: (args: never) => Promise<{ result: unknown; summary: string }> }

async function runAgent(service: PlanningService, profileId: string, request: Request, model: ToolModel) {
  const settings = service.settings(profileId)
  const timeZone = settings.timeZone
  const now = service.now()
  const today = localDate(now, timeZone)
  const steps: AssistantStep[] = []
  const notes: string[] = []
  const signal = AbortSignal.timeout(agentBudget.durationMs)
  let draft: PlanningDraft | null = null
  let calls = 0, proposals = 0

  /** A deadline phrase from the user («до пятницы») is resolved by the rule parser, not by the model. */
  const resolveDate = (value: string) => {
    if (isDateKey(value)) return value
    if (/^(сегодня|сейчас)$/iu.test(value.trim())) return today
    const parsed = parseItem(`задача: до ${value.replace(/^(до|к|ко|по|с|со|от)\s+/iu, '')}`, { now, timeZone })
    const due = parsed.due ? (isDateKey(parsed.due) ? parsed.due : localDate(new Date(parsed.due), timeZone)) : null
    if (!due) throw new Error(`Не понял срок «${value}»: передай дату YYYY-MM-DD из списка nextDays`)
    return due
  }
  const saveDraft = (items: DraftItem[], note: string) => {
    if (++proposals > agentBudget.proposals) throw new Error('Лимит черновиков исчерпан — заверши ответ текстом')
    if (draft) service.cancelDraft(profileId, draft.id)
    draft = service.saveProposal(profileId, request.message, items, [note])
    return draft
  }
  const occurrencesIn = (from: string, to: string) => service.occurrences(profileId, dayRange(from, timeZone).start, dayRange(to, timeZone).end)
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
  const tools: Record<string, Tool> = {
    get_day_plan: {
      description: 'План на один день: события со временем, задачи со сроком, просроченное, свободные окна в рабочие часы и пересечения.',
      schema: z.object({ date }),
      run: async ({ date: day }: { date: string }) => {
        const brief = service.brief(profileId, day)
        return {
          summary: `${day}: ${brief.events.length + brief.allDay.length} соб., ${brief.tasksDue.length} зад., окон ${brief.freeSlots.length}`,
          result: { date: day, weekday: weekdayName(day), events: brief.events.map((item) => ({ time: `${localTime(new Date(item.start), timeZone)}–${localTime(new Date(item.end), timeZone)}`, title: item.title, location: item.location || undefined })),
            allDay: brief.allDay.map((item) => item.title), tasksDue: brief.tasksDue.map((task) => ({ id: task.id, title: task.title, due: task.dueHasTime && task.due ? localTime(new Date(task.due), timeZone) : 'в течение дня', minutes: task.durationMinutes })),
            overdue: brief.overdue.map((task) => ({ id: task.id, title: task.title })), freeSlots: brief.freeSlots.map((slot) => `${localTime(new Date(slot.start), timeZone)}–${localTime(new Date(slot.end), timeZone)}`),
            conflicts: brief.conflicts.map((item) => `${item.first.title} × ${item.second.title}`), overload: brief.overload },
        }
      },
    },
    get_agenda: {
      description: 'Краткое расписание на несколько дней подряд (до 14): события и задачи по дням.',
      schema: z.object({ from: date, days: z.coerce.number().int().min(1).max(14).default(7) }),
      run: async ({ from, days }: { from: string; days: number }) => {
        const value = service.agenda(profileId, from, days)
        return {
          summary: `${days} дн. с ${from}`,
          result: value.days.map((day) => ({ date: day.date, weekday: weekdayName(day.date), events: day.occurrences.map((item) => `${item.allDay ? 'весь день' : `${localTime(new Date(item.start), timeZone)}–${localTime(new Date(item.end), timeZone)}`} ${item.title}`), tasks: day.tasks.filter((task) => task.status === 'open').map((task) => task.title) })),
        }
      },
    },
    find_free_slots: {
      description: 'Свободные окна не короче minutes в рабочие часы на days дней начиная с from.',
      schema: z.object({ from: date.optional(), days: z.coerce.number().int().min(1).max(14).default(5), minutes: z.coerce.number().int().min(15).max(600).default(60) }),
      run: async ({ from, days, minutes }: { from?: string; days: number; minutes: number }) => {
        const start = from && from >= today ? from : today
        const result = Array.from({ length: days }, (_, index) => {
          const day = addDays(start, index)
          const range = dayRange(day, timeZone)
          return { date: day, weekday: weekdayName(day), slots: freeSlots(service.occurrences(profileId, range.start, range.end), day, settings, now).slots.filter((slot) => slot.minutes >= minutes).map((slot) => ({ start: localTime(new Date(slot.start), timeZone), end: localTime(new Date(slot.end), timeZone), minutes: slot.minutes })) }
        })
        return { summary: `${result.reduce((sum, day) => sum + day.slots.length, 0)} окон от ${minutes} мин за ${days} дн.`, result }
      },
    },
    list_tasks: {
      description: 'Задачи: open — открытые, overdue — просроченные, done — выполненные. query — фильтр по названию или проекту.',
      schema: z.object({ filter: z.enum(['open', 'overdue', 'done']).default('open'), query: z.string().max(100).optional() }),
      run: async ({ filter, query }: { filter: 'open' | 'overdue' | 'done'; query?: string }) => {
        const text = query ? normalize(query) : ''
        const items = service.tasks(profileId).filter((task) => filter === 'done' ? task.status === 'done' : filter === 'overdue' ? isOverdue(task, now, timeZone) : task.status === 'open')
          .filter((task) => !text || normalize(`${task.title} ${task.project}`).includes(text)).slice(0, 30)
        return { summary: `${items.length} задач (${filter})`, result: items.map((task) => ({ id: task.id, title: task.title, due: task.due ? (task.dueHasTime ? `${localDate(new Date(task.due), timeZone)} ${localTime(new Date(task.due), timeZone)}` : task.due) : null, overdue: isOverdue(task, now, timeZone), priority: task.priority, minutes: task.durationMinutes, project: task.project || undefined, repeats: Boolean(task.rrule) })) }
      },
    },
    search_events: {
      description: 'Найти события по словам в названии в периоде (по умолчанию 30 дней назад — 120 дней вперёд).',
      schema: z.object({ query: z.string().trim().min(2).max(100), from: date.optional(), to: date.optional() }),
      run: async ({ query, from, to }: { query: string; from?: string; to?: string }) => {
        const text = normalize(query)
        const items = occurrencesIn(from || addDays(today, -30), to || addDays(today, 120)).filter((item) => normalize(item.title).includes(text)).slice(0, 20)
        return { summary: `найдено ${items.length}`, result: items.map((item) => ({ date: item.allDay ? item.start : localDate(new Date(item.start), timeZone), time: item.allDay ? 'весь день' : `${localTime(new Date(item.start), timeZone)}–${localTime(new Date(item.end), timeZone)}`, title: item.title })) }
      },
    },
    plan_blocks: {
      description: 'Распределить работу блоками по свободному времени до срока (подготовка к экзамену, проект, тренировки). Расчёт делает код: блоки встают только в свободные окна рабочих часов без пересечений. Создаёт черновик для подтверждения.',
      schema: z.object({
        title: z.string().trim().min(1).max(150), total_minutes: z.coerce.number().int().min(15).max(6000), block_minutes: z.coerce.number().int().min(15).max(480).default(60),
        until: z.string().trim().min(2).max(60).describe('срок: YYYY-MM-DD или фраза пользователя, например «до пятницы»'), from: z.string().trim().max(60).optional().describe('начало: YYYY-MM-DD или фраза; по умолчанию сегодня'), max_per_day: z.coerce.number().int().min(1).max(8).optional().describe('только если пользователь сам ограничил число блоков в день; иначе не передавай — код распределит равномерно'),
      }),
      run: async (args: { title: string; total_minutes: number; block_minutes: number; until: string; from?: string; max_per_day?: number }) => {
        const from = args.from ? resolveDate(args.from) : today
        const start = from > today ? from : today
        const until = resolveDate(args.until)
        if (until < start) throw new Error(`Срок ${until} раньше начала ${start}`)
        const days = Math.min(daysBetween(start, until) + 1, 60)
        const needed = Math.ceil(args.total_minutes / args.block_minutes)
        const perDay = args.max_per_day ?? Math.max(1, Math.ceil(needed / days))
        const blocks: { start: Date; end: Date }[] = []
        let remaining = args.total_minutes
        for (let index = 0; index < days && remaining > 0; index++) {
          const day = addDays(start, index)
          const range = dayRange(day, timeZone)
          let placed = 0
          for (const slot of freeSlots(service.occurrences(profileId, range.start, range.end), day, settings, now).slots) {
            // Start on a quarter hour; leave 15 minutes between blocks of one day.
            let cursor = Math.ceil(Date.parse(slot.start) / 900000) * 900000
            while (remaining > 0 && placed < perDay) {
              const length = Math.min(args.block_minutes, remaining)
              if (cursor + length * 60000 > Date.parse(slot.end)) break
              blocks.push({ start: new Date(cursor), end: new Date(cursor + length * 60000) })
              cursor += (length + 15) * 60000
              remaining -= length
              placed++
            }
            if (remaining <= 0 || placed >= perDay) break
          }
        }
        if (!blocks.length) throw new Error('До срока нет свободных окон подходящей длины — предложи пользователю сдвинуть срок или уменьшить блоки')
        const items: DraftItem[] = blocks.map((block, index) => ({
          kind: 'event', title: blocks.length > 1 ? `${args.title} (${index + 1}/${blocks.length})` : args.title, start: block.start.toISOString(), end: block.end.toISOString(), allDay: false, rrule: null,
          durationMinutes: Math.round((block.end.getTime() - block.start.getTime()) / 60000), assumptions: ['Время подобрано кодом по свободным окнам'], missing: [], conflicts: [],
        }))
        const shortfall = remaining > 0 ? `Не хватило свободного времени: размещено ${formatMinutes(args.total_minutes - remaining)} из ${formatMinutes(args.total_minutes)}.` : null
        const saved = saveDraft(items, `Черновик: ${blocks.length} блок(ов) по свободным окнам до ${until}, расчёт выполнен кодом.${shortfall ? ` ${shortfall}` : ''}`)
        return {
          summary: `${blocks.length} блок(ов), ${formatMinutes(args.total_minutes - remaining)} до ${until}, не больше ${perDay} в день${shortfall ? ' — не всё поместилось' : ''}`,
          result: { draftId: saved.id, blocks: blocks.map((block) => `${localDate(block.start, timeZone)} ${localTime(block.start, timeZone)}–${localTime(block.end, timeZone)}`), requested: { title: args.title, totalMinutes: args.total_minutes, blockMinutes: args.block_minutes, until, perDay }, placedMinutes: args.total_minutes - remaining, shortfall },
        }
      },
    },
    propose: {
      description: 'Предложить новые события и задачи. Ничего не сохраняет: создаёт черновик, пользователь подтвердит его сам. Повторный вызов заменяет предыдущий черновик. date — YYYY-MM-DD, start/end — ЧЧ:ММ местного времени; для события start обязателен, у задачи start — время срока (необязательно).',
      schema: proposalSchema,
      run: async (args: z.infer<typeof proposalSchema>) => {
        const items: DraftItem[] = []
        const warnings: string[] = []
        for (const [index, item] of args.items.entries()) {
          parseDateKey(item.date)
          if (item.date < today || item.date > addDays(today, 366)) throw new Error(`Пункт ${index + 1}: дата ${item.date} вне допустимого периода (сегодня ${today} — год вперёд)`)
          const rrule = repeatRule(item.repeat, item.date)
          const assumptions = ['Предложено агентом — проверьте перед сохранением']
          if (item.kind === 'task') {
            const due = item.start ? atLocalTime(item.date, item.start, timeZone).toISOString() : item.date
            items.push({ kind: 'task', title: item.title, due, dueHasTime: Boolean(item.start), durationMinutes: item.duration_minutes ?? null, rrule, assumptions, missing: [], conflicts: [] })
            continue
          }
          if (!item.start) throw new Error(`Пункт ${index + 1} («${item.title}»): для события нужен start`)
          const start = atLocalTime(item.date, item.start, timeZone)
          const end = item.end ? atLocalTime(item.date, item.end, timeZone) : new Date(start.getTime() + (item.duration_minutes || 60) * 60000)
          if (end <= start) throw new Error(`Пункт ${index + 1}: окончание раньше начала`)
          if (start < now) throw new Error(`Пункт ${index + 1}: время ${item.date} ${item.start} уже прошло`)
          if (item.start < settings.workStart || localTime(end, timeZone) > settings.workEnd) assumptions.push(`Вне рабочих часов ${settings.workStart}–${settings.workEnd}`)
          const draftItem: DraftItem = { kind: 'event', title: item.title, start: start.toISOString(), end: end.toISOString(), allDay: false, rrule, durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000), assumptions, missing: [], conflicts: service.conflictsFor(profileId, { kind: 'event', start: start.toISOString(), end: end.toISOString(), allDay: false }) }
          for (const other of items) if (other.kind === 'event' && other.start && other.end && Date.parse(other.start) < end.getTime() && Date.parse(other.end) > start.getTime()) draftItem.assumptions.push(`Пересекается с предложенным «${other.title}»`)
          if (draftItem.conflicts.length) warnings.push(`«${item.title}» пересекается с: ${draftItem.conflicts.map((conflict) => conflict.title).join(', ')}`)
          items.push(draftItem)
        }
        const saved = saveDraft(items, 'Черновик предложен агентом: даты, рабочие часы и пересечения проверены кодом.')
        return { summary: `черновик: ${items.length} пункт(ов)${warnings.length ? `, пересечений ${warnings.length}` : ''}`, result: { draftId: saved.id, items: items.length, conflicts: warnings } }
      },
    },
  }
  const specs: ToolSpec[] = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, parameters: z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown> }))

  async function execute(name: string, raw: unknown) {
    const started = performance.now()
    try {
      if (++calls > agentBudget.toolCalls) throw new Error('Бюджет инструментов исчерпан — ответь по собранным данным')
      const tool = tools[name]
      if (!tool) throw new Error(`Нет инструмента ${name}`)
      const args = tool.schema.parse(typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {})
      const { result, summary } = await tool.run(args as never)
      steps.push({ tool: name, status: 'ok', summary, durationMs: Math.round(performance.now() - started) })
      const text = JSON.stringify(result)
      return text.length <= 7000 ? text : JSON.stringify({ truncated: true, excerpt: text.slice(0, 6800) })
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'ошибка'
      steps.push({ tool: name, status: 'error', summary: message.slice(0, 200), durationMs: Math.round(performance.now() - started) })
      return JSON.stringify({ error: message })
    }
  }

  const system = `Ты — ассистент раздела «Дела и календарь». Отвечай по-русски, коротко и по делу.
Факты о расписании и задачах бери только из инструментов; не придумывай события, задачи и свободное время.
Чтобы распределить работу по времени («нужно 6 часов до пятницы блоками по 2 часа») — вызови plan_blocks: время рассчитает код. Сам часы не складывай и не считай.
Чтобы предложить конкретные события или задачи — сначала посмотри свободное время (find_free_slots или get_day_plan), затем вызови propose.
plan_blocks и propose создают только черновик, это безопасно: вызывай их сразу, не спрашивай разрешения. Пользователь сохранит черновик сам; не говори, что уже записал.
Даты — YYYY-MM-DD: бери их из списка nextDays в контексте, не вычисляй сам. Время — ЧЧ:ММ местного времени пользователя. В plan_blocks срок можно передать словами пользователя («до пятницы»). Не ставь события на занятое время; вне рабочих часов — только если пользователь просит.
Если propose вернул пересечения — перенеси пункты в свободные окна и вызови propose снова.
В продолжении разговора бери параметры (сколько часов, каким блоком, до какого срока) из предыдущих сообщений и меняй только то, что просит пользователь.
Если для предложения не хватает данных (сколько времени нужно, к какому сроку), задай один короткий вопрос вместо propose.
Закончив, ответь пользователю текстом без вызова инструментов: что нашёл и что предлагаешь; если создан черновик — перечисли его пункты и попроси проверить и сохранить.`
  // A ready-made calendar of the next two weeks: the model looks dates up instead of computing them.
  const context = { today, weekday: weekdayName(today), now: localTime(now, timeZone), timeZone, workHours: `${settings.workStart}–${settings.workEnd}`, nextDays: Array.from({ length: 14 }, (_, index) => `${addDays(today, index)} ${weekdayName(addDays(today, index))}`) }
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...request.history.slice(-6).map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) }) as ChatMessage),
    { role: 'user', content: `${request.message}\n\nКонтекст: ${JSON.stringify(context)}` },
  ]

  let answer = ''
  try {
    for (let turn = 0; turn < agentBudget.modelTurns && !signal.aborted; turn++) {
      const last = turn === agentBudget.modelTurns - 1 || calls >= agentBudget.toolCalls
      if (last) messages.push({ role: 'user', content: 'Инструменты больше недоступны. Ответь пользователю по уже собранным данным.' })
      const reply = await model.chat(messages, last ? [] : specs, signal)
      const content = reply.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      if (!reply.calls.length || last) { answer = content; break }
      messages.push({ role: 'assistant', content, calls: reply.calls })
      for (const call of reply.calls) messages.push({ role: 'tool', callId: call.id, name: call.name, content: await execute(call.name, call.arguments) })
    }
  } catch (error) {
    notes.push(`Модель недоступна или прервана: ${error instanceof Error ? error.message.slice(0, 160) : 'ошибка'}.`)
  }
  if (!answer) answer = draft ? 'Подготовил черновик — проверьте пункты ниже и сохраните.' : 'Не удалось получить ответ модели. Попробуйте переформулировать или задать вопрос проще: «что у меня завтра», «когда я свободен на 2 часа».'
  notes.push(`Агент: ${steps.length} вызовов инструментов${steps.some((step) => step.status === 'error') ? `, из них с ошибкой ${steps.filter((step) => step.status === 'error').length}` : ''}.`)
  return { answer, draft: draft as PlanningDraft | null, steps, notes }
}

/** Entry point for the website, Telegram and other agents. */
export async function answerRequest(service: PlanningService, profileId: string, input: unknown, model?: ToolModel): Promise<AssistantReply> {
  const request = assistantRequestSchema.parse(input)
  const settings = service.settings(profileId)
  const context = { now: service.now(), timeZone: settings.timeZone }
  const base = { id: randomUUID(), message: request.message, createdAt: service.now().toISOString() }
  const decision: Dispatch = request.mode === 'agent' ? { route: 'agent', reason: 'Агент вызван явно.' } : dispatch(request.message, context, request.history.length > 0)

  if (decision.route === 'agent') {
    if (!model) {
      const fallback = request.mode === 'agent' ? { route: 'help' as const, reason: 'Модель не настроена.' } : { ...dispatch(request.message.replace(/[?]/g, ''), context), reason: 'Модель не настроена — выполнен ближайший сценарий без неё.' }
      if (fallback.route === 'agent' || fallback.route === 'help') {
        return { ...base, route: 'help', draft: null, steps: [], model: null, notes: [decision.reason, 'Модель не настроена: задайте PLANNING_LLM_MODEL в backend/.env.'],
          answer: 'Для такого запроса нужна модель, а она не настроена. Без неё я умею: «что у меня завтра», «план на неделю», «когда я свободен на 2 часа», «какие задачи просрочены», а также добавлять дела фразами вроде «завтра в 15 созвон».' }
      }
      return answerRoute(service, profileId, request, fallback, base, [decision.reason, fallback.reason])
    }
    const result = await runAgent(service, profileId, request, model)
    return { ...base, route: 'agent', answer: result.answer, draft: result.draft, steps: result.steps, model: model.model, notes: [decision.reason, ...result.notes] }
  }
  return answerRoute(service, profileId, request, decision, base, [decision.reason])
}

async function answerRoute(service: PlanningService, profileId: string, request: Request, decision: Dispatch, base: Pick<AssistantReply, 'id' | 'message' | 'createdAt'>, notes: string[]): Promise<AssistantReply> {
  const settings = service.settings(profileId)
  const today = service.today(profileId)
  const reply = (route: AssistantRoute, answer: string, draft: PlanningDraft | null = null): AssistantReply => ({ ...base, route, answer, draft, steps: [], model: null, notes })
  switch (decision.route) {
    case 'day_plan': return reply('day_plan', service.brief(profileId, decision.date ?? today).text)
    case 'week': return reply('week', weekText(service.agenda(profileId, decision.date ?? today, 7), settings.timeZone))
    case 'free_slots': return reply('free_slots', slotsText(service, profileId, decision.date ?? today, decision.days ?? 5, decision.minutes ?? 60))
    case 'tasks': return reply('tasks', tasksText(service.tasks(profileId), service.now(), settings.timeZone))
    default: {
      const draft = await service.createDraft(profileId, { text: request.message })
      if (draft.method !== 'parser') notes.push('Для сложной фразы использована модель, даты вычислены правилами.')
      return reply('draft', draftText(draft, settings.timeZone), draft)
    }
  }
}
