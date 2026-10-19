import { z } from 'zod'
import type { PlanningSettings } from '../../../shared/planning.js'
import { validRule } from './recurrence.js'
import { isDateKey, isTimeZone } from './time.js'

export class PlanningError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message) }
}

export const profileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('default')
export const idSchema = z.string().regex(/^[a-zA-Z0-9_:.@-]{1,200}$/)
const dateOrInstant = z.string().max(40).refine((value) => isDateKey(value) || !Number.isNaN(Date.parse(value)) && /T/.test(value), 'Ожидается дата YYYY-MM-DD или время ISO 8601')
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ожидается время ЧЧ:ММ')
export const timeZoneSchema = z.string().max(64).refine(isTimeZone, 'Неизвестный часовой пояс')
const rruleSchema = z.string().trim().max(300).transform((value) => value.replace(/^RRULE:/i, '').toUpperCase()).refine(validRule, 'Некорректное правило повторения')
const reminder = z.number().int().min(-1).max(10080).nullable()

export const eventInputSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(200),
  description: z.string().max(4000).default(''),
  location: z.string().trim().max(300).default(''),
  allDay: z.boolean().default(false),
  start: dateOrInstant,
  end: dateOrInstant,
  timeZone: timeZoneSchema.optional(),
  rrule: rruleSchema.nullable().default(null),
  exdates: z.array(dateOrInstant).max(500).default([]),
  reminderMinutes: reminder.default(null),
  calendarId: idSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  const kind = (item: string) => isDateKey(item) ? 'date' : 'instant'
  if (value.allDay && (kind(value.start) !== 'date' || kind(value.end) !== 'date')) context.addIssue({ code: 'custom', message: 'Для события на весь день укажите даты YYYY-MM-DD', path: ['start'] })
  if (!value.allDay && (kind(value.start) !== 'instant' || kind(value.end) !== 'instant')) context.addIssue({ code: 'custom', message: 'Для события со временем укажите время ISO 8601', path: ['start'] })
  if (value.allDay ? value.end <= value.start : Date.parse(value.end) <= Date.parse(value.start)) context.addIssue({ code: 'custom', message: 'Окончание должно быть позже начала', path: ['end'] })
}).transform((value) => ({ ...value, start: normalize(value.start), end: normalize(value.end), exdates: value.exdates.map(normalize) }))

export const eventPatchSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(4000), location: z.string().trim().max(300),
  allDay: z.boolean(), start: dateOrInstant, end: dateOrInstant, timeZone: timeZoneSchema, rrule: rruleSchema.nullable(),
  exdates: z.array(dateOrInstant).max(500), reminderMinutes: reminder, calendarId: idSchema.nullable(),
}).partial().strict()

export const taskInputSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(200),
  notes: z.string().max(4000).default(''),
  project: z.string().trim().max(80).default(''),
  due: dateOrInstant.nullable().default(null),
  dueHasTime: z.boolean().optional(),
  timeZone: timeZoneSchema.optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().default(null),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  status: z.enum(['open', 'done']).default('open'),
  reminderMinutes: reminder.default(null),
  rrule: rruleSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.rrule && !value.due) context.addIssue({ code: 'custom', message: 'Для повторяющейся задачи укажите первый срок', path: ['due'] })
}).transform((value) => ({ ...value, due: value.due ? normalize(value.due) : null, dueHasTime: value.due ? !isDateKey(value.due) : false }))

export const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(200), notes: z.string().max(4000), project: z.string().trim().max(80),
  due: dateOrInstant.nullable(), durationMinutes: z.number().int().min(5).max(1440).nullable(),
  timeZone: timeZoneSchema,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]), status: z.enum(['open', 'done']), reminderMinutes: reminder,
  rrule: rruleSchema.nullable(),
}).partial().strict()

export const defaultSettings: PlanningSettings = {
  timeZone: 'Europe/Moscow', briefEnabled: true, briefTime: '08:00', defaultReminderMinutes: 15, taskReminderMinutes: 60,
  workStart: '09:00', workEnd: '19:00', syncIntervalMinutes: 5, defaultCalendarId: null,
}
export const settingsSchema = z.object({
  timeZone: timeZoneSchema, briefEnabled: z.boolean(), briefTime: clock,
  defaultReminderMinutes: z.number().int().min(0).max(1440), taskReminderMinutes: z.number().int().min(0).max(10080),
  workStart: clock, workEnd: clock, syncIntervalMinutes: z.number().int().min(1).max(1440), defaultCalendarId: idSchema.nullable(),
}).partial().strict()

export const draftRequestSchema = z.object({ text: z.string().trim().min(1, 'Напишите, что запланировать').max(1000), useAi: z.boolean().default(true), force: z.boolean().default(false) }).strict()
export const draftItemSchema = z.object({
  kind: z.enum(['event', 'task']), title: z.string().trim().min(1).max(200),
  start: dateOrInstant.optional(), end: dateOrInstant.optional(), allDay: z.boolean().optional(), rrule: rruleSchema.nullable().optional(),
  due: dateOrInstant.nullable().optional(), dueHasTime: z.boolean().optional(), durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  reminderMinutes: reminder.optional(),
}).strip()
export const confirmSchema = z.object({ items: z.array(draftItemSchema).min(1).max(10).optional() }).strict()

export const calendarPatchSchema = z.object({ enabled: z.boolean() }).strict()
export const googleConfigSchema = z.object({
  clientId: z.string().trim().regex(/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/, 'Client ID должен заканчиваться на .apps.googleusercontent.com'),
  clientSecret: z.string().trim().min(10).max(200),
}).strict()
export const yandexConnectSchema = z.object({
  login: z.string().trim().min(3).max(200),
  password: z.string().trim().min(8).max(200),
  calendarUrl: z.string().trim().max(500).optional(),
}).strict()
export const telegramTokenSchema = z.object({ token: z.string().trim().regex(/^\d{5,16}:[\w-]{30,64}$/, 'Токен выглядит как 123456789:AA… — скопируйте его из @BotFather целиком') }).strict()

/** What a language model may return: segmentation and verbatim phrases. Dates are computed by code. */
export const modelExtractionSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(['event', 'task']),
    title: z.string().trim().max(200),
    when: z.string().trim().max(120).default(''),
    deadline: z.string().trim().max(120).default(''),
    duration: z.string().trim().max(60).default(''),
    repeat: z.string().trim().max(80).default(''),
  })).max(8),
  question: z.string().trim().max(300).default(''),
})

function normalize(value: string) { return isDateKey(value) ? value : new Date(value).toISOString() }

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1, 'Напишите вопрос или что запланировать').max(1000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict()).max(12).default([]),
  mode: z.enum(['auto', 'agent']).default('auto'),
}).strict()

const clockValue = z.string().trim().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'Время в формате ЧЧ:ММ').transform((value) => value.split(':').slice(0, 2).map((part) => part.padStart(2, '0')).join(':'))
/** What the agent may propose. Code converts it to a draft, checks dates, working hours and conflicts. */
export const proposalSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(['event', 'task']),
    title: z.string().trim().min(1).max(200),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
    start: clockValue.optional(),
    end: clockValue.optional(),
    duration_minutes: z.coerce.number().int().min(5).max(1440).optional(),
    repeat: z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly']).optional(),
  })).min(1).max(10),
})
