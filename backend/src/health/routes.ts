import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { daySummary, healthStats } from '../../../shared/health-math.mjs'
import { HealthService } from './service.js'
import { dateSchema, HealthError, identifier, profileSchema } from './schema.js'

const profile = (request: FastifyRequest) => profileSchema.parse(request.query ?? {}).profileId
const id = (request: FastifyRequest) => z.object({ id: identifier }).parse(request.params).id
export function registerHealthRoutes(app: FastifyInstance, service: HealthService) {
  const base = '/api/sport'
  app.get(`${base}/state`, async request => service.store.state(profile(request)))
  app.get(`${base}/capabilities`, async () => ({ ai: false, photoAttachments: true }))
  app.post(`${base}/assistant/:operation`, async request => {
    const { operation } = z.object({ operation: z.enum(['parse-workout', 'recognize-food', 'explain-progress', 'suggest-workout']) }).parse(request.params)
    return service.assistant.run(operation)
  })
  app.get(`${base}/settings`, async request => { const p = profile(request); service.store.ensureProfile(p); return service.store.settings(p) })
  app.put(`${base}/settings`, async request => service.settings(profile(request), request.body))
  app.get(`${base}/summary`, async request => {
    const { date } = z.object({ date: dateSchema }).parse(request.query)
    return daySummary(service.store.state(profile(request)), date)
  })
  app.get(`${base}/stats`, async request => {
    const query = z.object({ to: dateSchema, days: z.coerce.number().refine(value => [7, 30, 90].includes(value)), exerciseId: identifier.optional() }).parse(request.query)
    return healthStats(service.store.state(profile(request)), query.to, query.days, query.exerciseId)
  })
  for (const kind of ['exercises', 'products', 'workouts', 'templates', 'meals', 'wellbeing'] as const) {
    const options = { bodyLimit: kind === 'meals' ? 9 * 1024 * 1024 : 256 * 1024 }
    app.get(`${base}/${kind}`, async request => { const p = profile(request); service.store.ensureProfile(p); return service.store.list(p, kind) })
    app.get(`${base}/${kind}/:id`, async request => service.store.require(profile(request), kind, id(request)))
    app.post(`${base}/${kind}`, options, async (request, reply) => reply.code(201).send(await service.save(profile(request), kind, request.body)))
    app.put(`${base}/${kind}/:id`, options, async request => service.save(profile(request), kind, request.body, id(request)))
    app.delete(`${base}/${kind}/:id`, async request => { service.store.remove(profile(request), kind, id(request)); return { deleted: true } })
  }
  app.get(`${base}/meals/:id/photo`, async (request, reply) => {
    const data = service.store.photo(profile(request), id(request))
    if (!data) throw new HealthError('Фото не найдено', 404)
    return reply.type('image/webp').header('X-Content-Type-Options', 'nosniff').send(Buffer.from(data))
  })
  app.addHook('onClose', async () => service.close())
}
