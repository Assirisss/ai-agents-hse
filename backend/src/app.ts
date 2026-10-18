import Fastify from 'fastify'
import { ZodError } from 'zod'
import { ResearchError } from './trends/schema.js'
import { TrendResearchService } from './trends/service.js'
import { registerTrendRoutes } from './trends/routes.js'
import { RunpodBiRefNet, PhotoProcessingError, registerPhotoRoutes, type BackgroundRemover } from './wardrobe/photos.js'
import { WardrobeAgentError, WardrobeAgentService } from './wardrobe/agent.js'
import { registerWardrobeAgentRoutes } from './wardrobe/agent-routes.js'
import type { ResearchPlanner } from './trends/planner.js'
import { OpenRouterWardrobeVision, type WardrobeVision } from './wardrobe/vision.js'
import { PlanningError } from './planning/schema.js'
import { registerPlanningRoutes } from './planning/routes.js'
import type { PlanningService } from './planning/service.js'

type AppOptions = {
  remover?: BackgroundRemover
  wardrobePlanner?: ResearchPlanner
  vision?: WardrobeVision
  planning?: PlanningService
}

export function createApp(service = new TrendResearchService(), options: AppOptions = {}) {
  const { remover = new RunpodBiRefNet(), wardrobePlanner, vision = new OpenRouterWardrobeVision(), planning } = options
  const app = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: 15000 })
  app.addHook('onRequest', async (request, reply) => {
    // This development service is local-only, with same-origin access through Vite.
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin)
        if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
          return reply.code(403).send({ error: 'Недопустимый источник запроса' })
        }
      } catch { return reply.code(403).send({ error: 'Недопустимый источник запроса' }) }
    }
  })
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  app.get('/api/health', async () => ({ status: 'ok' }))
  registerTrendRoutes(app, service)
  app.register(async (scope) => registerPhotoRoutes(scope, remover))
  const stylist = new WardrobeAgentService(wardrobePlanner, (input, signal) => service.search(input, { signal }), facts => {
    service.memory.saveModuleContext('default', { module: 'wardrobe', source: 'Сводка из чата гардероба', facts })
  })
  registerWardrobeAgentRoutes(app, stylist, vision)
  if (planning) {
    registerPlanningRoutes(app, planning)
    app.addHook('onClose', async () => planning.close())
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      // Planning forms show the first message as is, so it has to be readable.
      if (request.url.startsWith('/api/planning')) return reply.code(400).send({ error: issues[0]?.message && !/^(Invalid|Expected|Unrecognized)/.test(issues[0].message) ? issues[0].message : `Некорректное поле ${issues[0]?.path || ''}`.trim(), issues })
      return reply.code(400).send({ error: 'Некорректные параметры исследования', issues })
    }
    if (error instanceof ResearchError || error instanceof PlanningError) return reply.code(error.statusCode).send({ error: error.message })
    if (error instanceof PhotoProcessingError || error instanceof WardrobeAgentError) return reply.code(error.statusCode).send({ error: error.message })
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ error: status === 413 ? 'Слишком большой запрос' : status === 400 ? 'Некорректный JSON' : status === 415 ? 'Ожидается application/json' : (request.url.startsWith('/api/planning') ? 'Ошибка раздела «Дела и календарь»' : 'Ошибка службы исследований') })
  })
  return app
}
