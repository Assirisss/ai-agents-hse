import Fastify from 'fastify'
import { ZodError } from 'zod'
import { ResearchError } from './trends/schema.js'
import { TrendResearchService } from './trends/service.js'
import { registerTrendRoutes } from './trends/routes.js'

export function createApp(service = new TrendResearchService()) {
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Некорректные параметры исследования', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) })
    if (error instanceof ResearchError) return reply.code(error.statusCode).send({ error: error.message })
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ error: status === 413 ? 'Слишком большой запрос' : status === 400 ? 'Некорректный JSON' : status === 415 ? 'Ожидается application/json' : 'Ошибка службы исследований' })
  })
  return app
}
