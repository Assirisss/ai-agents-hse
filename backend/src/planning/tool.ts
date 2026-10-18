import { z } from 'zod'
import type { PlanningService } from './service.js'
import { freeSlots } from './agenda.js'
import { addDays, dayRange } from './time.js'

const profile = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('default')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Tools for a future orchestrator. They call the same service as the website and Telegram.
 * A draft is only a proposal: saving requires an explicit confirmation by the user.
 */
export function createPlanningTools(service: PlanningService) {
  const daySchema = z.object({ profileId: profile, date: date.optional() }).strict()
  const draftSchema = z.object({ profileId: profile, text: z.string().trim().min(1).max(1000) }).strict()
  const slotsSchema = z.object({ profileId: profile, from: date.optional(), days: z.number().int().min(1).max(14).default(5), minutes: z.number().int().min(15).max(600).default(60) }).strict()
  const askSchema = z.object({ profileId: profile, message: z.string().trim().min(1).max(1000) }).strict()
  return [
    {
      name: 'planning_assistant',
      description: 'Ассистент раздела «Дела и календарь»: отвечает на вопросы о расписании и задачах, распределяет работу по свободному времени. Изменения возвращаются черновиком (draft) для подтверждения пользователем.',
      inputSchema: z.toJSONSchema(askSchema),
      execute: async (input: unknown) => { const args = askSchema.parse(input); return service.ask(args.profileId, { message: args.message }) },
    },
    {
      name: 'planning_day_brief',
      description: 'План на день: события, задачи со сроком, просроченное, пересечения, свободные окна в рабочие часы и оценка перегрузки. Только чтение.',
      inputSchema: z.toJSONSchema(daySchema),
      execute: async (input: unknown) => { const args = daySchema.parse(input); return service.brief(args.profileId, args.date) },
    },
    {
      name: 'planning_find_free_slots',
      description: 'Найти свободные окна заданной длительности в рабочие часы на ближайшие дни. Только чтение.',
      inputSchema: z.toJSONSchema(slotsSchema),
      execute: async (input: unknown) => {
        const args = slotsSchema.parse(input)
        const settings = service.settings(args.profileId)
        const start = args.from || service.today(args.profileId)
        return Array.from({ length: args.days }, (_, index) => {
          const day = addDays(start, index)
          const range = dayRange(day, settings.timeZone)
          const occurrences = service.occurrences(args.profileId, range.start, range.end)
          return { date: day, slots: freeSlots(occurrences, day, settings, service.now()).slots.filter((slot) => slot.minutes >= args.minutes) }
        })
      },
    },
    {
      name: 'planning_draft_from_text',
      description: 'Разобрать свободный текст в черновик событий и задач. Ничего не сохраняет: верните черновик пользователю для подтверждения.',
      inputSchema: z.toJSONSchema(draftSchema),
      execute: async (input: unknown) => { const args = draftSchema.parse(input); return service.createDraft(args.profileId, { text: args.text }) },
    },
  ]
}
