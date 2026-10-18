import { randomUUID } from 'node:crypto'
import { clientToolResultSchema } from './client-schema.js'
import type { WardrobeClientResult } from '../../../shared/wardrobe-tools.js'
import type { FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import { PassThrough } from 'node:stream'
import type { WardrobeAgentEvent } from '../../../shared/wardrobe-agent.js'
import type { WardrobeAgentService } from './agent.js'
import { WardrobeAgentError } from './agent.js'
import { chatRequestSchema } from './agent-schema.js'
import { WardrobeVisionError, type WardrobeVision } from './vision.js'

export function registerWardrobeAgentRoutes(app: FastifyInstance, service: WardrobeAgentService, vision: WardrobeVision) {
  // Each opaque token authorizes exactly one pending call in one live stream.
  const pending = new Map<string, { resolve: (result: WardrobeClientResult) => void; callId: string }>()
  app.post('/api/wardrobe/agent/tool-results/:token', { bodyLimit: 16000 }, async (request, reply) => {
    const token = (request.params as { token: string }).token
    const item = pending.get(token)
    if (!item) return reply.code(404).send({ error: 'Вызов инструмента уже завершён или отменён.' })
    const body = z.object({ callId: z.string(), result: clientToolResultSchema }).strict().parse(request.body)
    if (body.callId !== item.callId) return reply.code(409).send({ error: 'Результат относится к другому вызову.' })
    pending.delete(token)
    item.resolve(body.result)
    return { accepted: true }
  })
  app.get('/api/wardrobe/agent/capabilities', async () => ({ ...service.capabilities(), vision: { configured: vision.configured, provider: vision.configured ? vision.provider : null } }))
  app.post('/api/wardrobe/agent/photos/inspect', { bodyLimit: 3_100_000 }, async (request, reply) => {
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableFinished) controller.abort() }
    reply.raw.once('close', abort)
    try { return await vision.inspect(request.body, controller.signal) }
    catch (error) {
      if (error instanceof WardrobeVisionError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, retryable: error.retryable })
      if (error instanceof ZodError) return reply.code(400).send({ error: 'Проверьте фотографию и текст сообщения.' })
      throw error
    } finally { reply.raw.off('close', abort) }
  })
  app.post('/api/wardrobe/agent/chat', { bodyLimit: 2_000_000 }, async (request, reply) => {
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableFinished) controller.abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    try { return await service.chat(request.body, controller.signal) }
    catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'Не удалось проверить сообщение или данные гардероба.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
      throw error
    } finally {
      request.raw.off('aborted', abort)
      reply.raw.off('close', abort)
    }
  })
  app.post('/api/wardrobe/agent/chat/stream', { bodyLimit: 2_000_000 }, (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Не удалось проверить сообщение или данные гардероба.' })
    const controller = new AbortController()
    const output = new PassThrough()
    let completed = false
    output.on('close', () => { if (!completed) controller.abort() })
    reply.raw.once('close', () => {
      if (!completed) { controller.abort(); output.destroy() }
    })
    reply.type('application/x-ndjson; charset=utf-8').header('X-Accel-Buffering', 'no').send(output)
    const send = (event: WardrobeAgentEvent) => { if (!output.destroyed && !controller.signal.aborted) output.write(`${JSON.stringify(event)}\n`) }
    const clientExecute: Parameters<WardrobeAgentService['chat']>[3] = (call, signal) => new Promise((resolve, reject) => {
      const token = randomUUID()
      const abort = () => { pending.delete(token); reject(new WardrobeAgentError('Выполнение инструмента остановлено.', 408)) }
      if (signal.aborted) { abort(); return }
      pending.set(token, { callId: call.id, resolve: result => { signal.removeEventListener('abort', abort); resolve(result) } })
      signal.addEventListener('abort', abort, { once: true })
      send({ type: 'tool_request', token, call })
    })
    void (async () => {
      try {
        const result = await service.chat(parsed.data, controller.signal, progress => send({ type: 'progress', progress }), clientExecute)
        send({ type: 'result', reply: result })
      } catch (error) { send({ type: 'error', error: error instanceof WardrobeAgentError ? error.message : 'Не удалось завершить запрос стилиста.' }) }
      finally { completed = true; if (!output.destroyed) output.end() }
    })()
    return reply
  })
  app.addHook('preClose', async () => service.close())
}
