import { PassThrough } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { TrendChatEvent } from '../../../shared/trend-chat.js'
import { chatRequestSchema, conversationParams } from './chat-schema.js'
import { profileIdSchema, ResearchError } from './schema.js'
import { TrendChatService } from './chat.js'
import { trendChatToolInfo } from './chat-tools.js'
import type { TrendResearchService } from './service.js'

export function registerTrendChatRoutes(app: FastifyInstance, research: TrendResearchService) {
  const chat = new TrendChatService(research, research.conversationPlanner())
  const base = '/api/trends/chat/:profileId/conversations'
  app.get('/api/trends/chat/tools', async () => trendChatToolInfo)
  app.get(base, async (request) => {
    const { profileId } = z.object({ profileId: profileIdSchema }).parse(request.params)
    return research.memory.chats.list(profileId)
  })
  app.post(base, async (request) => {
    const { profileId } = z.object({ profileId: profileIdSchema }).parse(request.params)
    const { reportId } = z.object({ reportId: z.string().uuid().optional() }).strict().parse(request.body || {})
    return chat.create(profileId, reportId)
  })
  app.get(`${base}/:id`, async (request) => {
    const { profileId, id } = conversationParams.parse(request.params)
    return research.memory.chats.get(profileId, id)
  })
  app.post(`${base}/:id/messages/stream`, { bodyLimit: 16384 }, (request, reply) => {
    const { profileId, id } = conversationParams.parse(request.params)
    const input = chatRequestSchema.parse(request.body)
    research.memory.chats.get(profileId, id)
    const controller = new AbortController(), output = new PassThrough()
    let completed = false
    output.on('close', () => { if (!completed) controller.abort() })
    reply.type('application/x-ndjson; charset=utf-8').header('X-Accel-Buffering', 'no').send(output)
    const send = (event: TrendChatEvent) => { if (!output.destroyed && !controller.signal.aborted) output.write(`${JSON.stringify(event)}\n`) }
    void (async () => {
      try {
        const result = await chat.send(profileId, id, input, { signal: controller.signal, onProgress: (progress) => send({ type: 'progress', progress }) })
        send({ type: 'result', result })
      } catch (error) {
        if (!controller.signal.aborted) send({ type: 'error', error: error instanceof ResearchError ? error.message : 'Не удалось завершить сообщение. Диалог можно обновить и повторить отправку.' })
      } finally { completed = true; if (!output.destroyed) output.end() }
    })()
    return reply
  })
}
