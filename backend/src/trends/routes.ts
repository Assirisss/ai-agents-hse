import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { profileIdSchema, ResearchError } from './schema.js'
import { canonicalUrl } from './ranking.js'
import type { TrendResearchService } from './service.js'

export function registerTrendRoutes(app: FastifyInstance, service: TrendResearchService) {
  app.get('/api/trends/capabilities', async () => service.capabilities())
  app.post('/api/trends/research', async (request) => service.search(request.body))
  app.get('/api/trends/profiles/:id', async (request) => {
    const { id } = z.object({ id: profileIdSchema }).parse(request.params)
    return service.memory.profile(id)
  })
  app.put('/api/trends/profiles/:id', { bodyLimit: 16384 }, async (request) => {
    const { id } = z.object({ id: profileIdSchema }).parse(request.params)
    return service.memory.saveProfile(id, request.body)
  })
  app.get('/api/trends/profiles/:id/modules', async (request) => {
    const { id } = z.object({ id: profileIdSchema }).parse(request.params)
    return service.memory.moduleContexts(id)
  })
  app.put('/api/trends/profiles/:id/modules', { bodyLimit: 16384 }, async (request) => {
    const { id } = z.object({ id: profileIdSchema }).parse(request.params)
    return service.memory.saveModuleContext(id, request.body)
  })
  app.get('/api/trends/memory', async (request) => {
    const args = z.object({ profileId: profileIdSchema.default('default'), query: z.string().max(160).default('') }).strict().parse(request.query)
    return service.memory.state(args.profileId, args.query)
  })
  app.get('/api/trends/profiles/:id/history/:runId', async (request) => {
    const args = z.object({ id: profileIdSchema, runId: z.string().uuid() }).parse(request.params)
    const report = service.memory.report(args.id, args.runId)
    if (!report) throw new ResearchError('Исследование не найдено в этом профиле', 404)
    return report
  })
  app.delete('/api/trends/profiles/:id/history/:runId', async (request) => {
    const args = z.object({ id: profileIdSchema, runId: z.string().uuid() }).parse(request.params)
    return { deleted: service.memory.forget(args.id, args.runId) }
  })
  app.post('/api/trends/feedback', async (request) => {
    const args = z.object({ profileId: profileIdSchema.default('default'), url: z.string().max(2000), verdict: z.enum(['useful', 'not_useful']) }).strict().parse(request.body)
    const url = canonicalUrl(args.url)
    if (!url) throw new ResearchError('Недопустимая ссылка')
    service.memory.feedback(args.profileId, url, args.verdict)
    return { saved: true }
  })
  app.addHook('onClose', async () => service.close())
}
