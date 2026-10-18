import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { idSchema, PlanningError, profileIdSchema } from './schema.js'
import type { PlanningService } from './service.js'
import { dayRange } from './time.js'

const profileOf = (request: FastifyRequest) => z.object({ profileId: profileIdSchema }).passthrough().parse(request.query ?? {}).profileId
const params = (request: FastifyRequest) => z.object({ id: idSchema }).parse(request.params)
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export function registerPlanningRoutes(app: FastifyInstance, service: PlanningService) {
  const base = '/api/planning'
  app.get(`${base}/capabilities`, async () => service.capabilities())
  app.get(`${base}/settings`, async (request) => service.settings(profileOf(request)))
  app.put(`${base}/settings`, async (request) => service.saveSettings(profileOf(request), request.body))

  app.get(`${base}/brief`, async (request) => {
    const { date } = z.object({ date: dateParam.optional() }).passthrough().parse(request.query)
    return service.brief(profileOf(request), date)
  })
  app.get(`${base}/agenda`, async (request) => {
    const query = z.object({ from: dateParam.optional(), days: z.coerce.number().int().min(1).max(42).default(7) }).passthrough().parse(request.query)
    return service.agenda(profileOf(request), query.from, query.days)
  })
  app.get(`${base}/occurrences`, async (request) => {
    const profileId = profileOf(request)
    const query = z.object({ from: dateParam, to: dateParam }).passthrough().parse(request.query)
    const timeZone = service.settings(profileId).timeZone
    if (query.to < query.from) throw new PlanningError('Конец периода раньше начала')
    return service.occurrences(profileId, dayRange(query.from, timeZone).start, dayRange(query.to, timeZone).end)
  })

  app.get(`${base}/events/:id`, async (request) => service.event(profileOf(request), params(request).id))
  app.post(`${base}/events`, async (request) => service.createEvent(profileOf(request), request.body))
  app.put(`${base}/events/:id`, async (request) => service.updateEvent(profileOf(request), params(request).id, request.body))
  app.delete(`${base}/events/:id`, async (request) => service.deleteEvent(profileOf(request), params(request).id))
  app.post(`${base}/events/:id/skip`, async (request) => {
    const { start } = z.object({ start: z.string().max(40) }).strict().parse(request.body)
    return service.skipOccurrence(profileOf(request), params(request).id, start)
  })

  app.get(`${base}/tasks`, async (request) => service.tasks(profileOf(request)))
  app.post(`${base}/tasks`, async (request) => service.createTask(profileOf(request), request.body))
  app.put(`${base}/tasks/:id`, async (request) => service.updateTask(profileOf(request), params(request).id, request.body))
  app.post(`${base}/tasks/:id/complete`, async (request) => service.completeTask(profileOf(request), params(request).id))
  app.delete(`${base}/tasks/:id`, async (request) => service.deleteTask(profileOf(request), params(request).id))

  app.post(`${base}/assistant`, { bodyLimit: 65536 }, async (request) => service.ask(profileOf(request), request.body))
  app.post(`${base}/drafts`, async (request) => service.createDraft(profileOf(request), request.body))
  app.post(`${base}/drafts/:id/confirm`, { bodyLimit: 32768 }, async (request) => service.confirmDraft(profileOf(request), params(request).id, request.body ?? {}))
  app.delete(`${base}/drafts/:id`, async (request) => service.cancelDraft(profileOf(request), params(request).id))

  app.get(`${base}/accounts`, async (request) => service.accounts(profileOf(request)))
  app.delete(`${base}/accounts/:id`, async (request) => service.deleteAccount(profileOf(request), params(request).id))
  app.post(`${base}/accounts/:id/sync`, async (request) => service.syncAccount(profileOf(request), params(request).id))
  app.post(`${base}/accounts/:id/refresh`, async (request) => service.refreshCalendars(profileOf(request), params(request).id))
  app.put(`${base}/calendars/:id`, async (request) => service.updateCalendar(profileOf(request), params(request).id, request.body))
  app.get(`${base}/events/local`, async (request) => ({ count: service.localEvents(profileOf(request)).length }))
  app.post(`${base}/calendars/:id/move-local`, async (request) => service.moveLocalEvents(profileOf(request), params(request).id))
  app.get(`${base}/sync/log`, async (request) => service.syncLog(profileOf(request)))
  app.post(`${base}/yandex/connect`, async (request) => service.connectYandex(profileOf(request), request.body))

  app.get(`${base}/google/config`, async () => service.googleConfig())
  app.put(`${base}/google/config`, async (request) => service.saveGoogleConfig(request.body))
  app.post(`${base}/google/start`, async (request) => service.googleStart(profileOf(request)))
  // Google redirects the browser here; the answer is a redirect back to the website, never JSON.
  app.get(`${base}/google/callback`, async (request, reply) => {
    const query = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).passthrough().parse(request.query)
    const back = (status: string, message?: string) => reply.redirect(`${service.publicUrl}/?planning=${status}${message ? `&message=${encodeURIComponent(message.slice(0, 300))}` : ''}`)
    if (query.error || !query.code || !query.state) return back('google-error', query.error === 'access_denied' ? 'Доступ не выдан' : 'Google не вернул код входа')
    try { await service.googleCallback(query.code, query.state); return back('google-connected') }
    catch (error) { return back('google-error', error instanceof Error ? error.message : 'Не удалось подключить Google') }
  })

  app.get(`${base}/telegram`, async (request) => service.telegramStatus(profileOf(request)))
  app.put(`${base}/telegram`, async (request) => service.configureTelegram(profileOf(request), request.body))
  app.delete(`${base}/telegram`, async (request) => service.removeTelegram(profileOf(request)))
  app.post(`${base}/telegram/link`, async (request) => service.telegramLink(profileOf(request)))
  app.post(`${base}/telegram/test`, async (request) => service.sendTest(profileOf(request)))
  app.delete(`${base}/telegram/chats/:id`, async (request) => service.unlinkChat(profileOf(request), z.object({ id: z.string().regex(/^-?\d{1,20}$/) }).parse(request.params).id))

  app.get(`${base}/context`, async (request) => ({ module: 'planning', source: 'Сводка раздела «Дела и календарь»', facts: service.moduleFacts(profileOf(request)) }))
}
