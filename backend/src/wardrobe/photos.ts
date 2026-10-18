import type { FastifyInstance } from 'fastify'

const maxBytes = 6 * 1024 * 1024
const maxResponseBytes = 8 * 1024 * 1024
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const jobIdPattern = /^[a-zA-Z0-9_-]{1,128}$/

export class PhotoProcessingError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}

export type PhotoJob = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; error?: string }
export interface BackgroundRemover {
  readonly configured: boolean
  start(image: Buffer, contentType: string): Promise<PhotoJob>
  status(id: string): Promise<PhotoJob>
  result(id: string): Promise<Buffer>
  cancel(id: string): Promise<void>
}

type RunpodJob = { id?: string; status?: string; output?: { image_base64?: string; error?: string }; error?: unknown }
type OwnedJob = { expires: number; result?: Buffer }

/** Queue jobs survive cold starts; credentials and provider responses stay on the server. */
export class RunpodBiRefNet implements BackgroundRemover {
  readonly configured: boolean
  private readonly jobs = new Map<string, OwnedJob>()

  constructor(private readonly endpointId = process.env.RUNPOD_BIREFNET_ENDPOINT_ID?.trim(),
    private readonly apiKey = process.env.RUNPOD_API_KEY?.trim(), private readonly fetcher: typeof fetch = fetch) {
    if (endpointId && !/^[a-zA-Z0-9_-]{1,80}$/.test(endpointId)) throw new Error('Некорректный RUNPOD_BIREFNET_ENDPOINT_ID.')
    this.configured = Boolean(endpointId && apiKey)
  }

  private async request(path: string, body?: unknown): Promise<RunpodJob> {
    if (!this.configured) throw new PhotoProcessingError('Обработчик фото пока не настроен. Оригинал можно сохранить.', 503)
    try {
      const response = await this.fetcher(`https://api.runpod.ai/v2/${this.endpointId}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new PhotoProcessingError(response.status === 429 ? 'Обработчик занят. Попробуйте позже.' : 'Сервис обработки фото недоступен. Попробуйте позже.', response.status === 429 ? 429 : 502)
      }
      if (!response.body) throw new Error('Missing response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxResponseBytes) throw new Error('Oversized response')
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response')
      return data as RunpodJob
    } catch (cause) {
      if (cause instanceof PhotoProcessingError) throw cause
      throw new PhotoProcessingError('Не удалось связаться с сервисом обработки фото. Попробуйте ещё раз.', 502)
    }
  }

  private owned(id: string) {
    const job = this.jobs.get(id)
    if (!jobIdPattern.test(id) || !job || job.expires < Date.now()) {
      this.jobs.delete(id)
      throw new PhotoProcessingError('Задача не найдена или срок её хранения истёк. Запустите обработку снова.', 404)
    }
    return job
  }

  async start(image: Buffer, contentType: string): Promise<PhotoJob> {
    for (const [id, job] of this.jobs) if (job.expires < Date.now()) this.jobs.delete(id)
    if (this.jobs.size >= 16) throw new PhotoProcessingError('Слишком много задач обработки. Попробуйте позже.', 429)
    const data = await this.request('run', {
      input: { input_data: { image_base64: image.toString('base64'), mime_type: contentType } },
      policy: { executionTimeout: 180_000 },
    })
    if (!data.id || !jobIdPattern.test(data.id)) throw new PhotoProcessingError('Сервис не вернул идентификатор задачи.', 502)
    this.jobs.set(data.id, { expires: Date.now() + 15 * 60_000 })
    return { id: data.id, status: 'queued' }
  }

  async status(id: string): Promise<PhotoJob> {
    const job = this.owned(id)
    if (job.result) return { id, status: 'succeeded' }
    const data = await this.request(`status/${id}`)
    if (data.status === 'IN_QUEUE') return { id, status: 'queued' }
    if (data.status === 'IN_PROGRESS') return { id, status: 'running' }
    if (data.status === 'CANCELLED') return { id, status: 'cancelled' }
    if (data.status === 'COMPLETED' && data.output && typeof data.output.image_base64 === 'string' && !data.output.error) {
      const encoded = data.output.image_base64
      if (encoded.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new PhotoProcessingError('Сервис вернул некорректное изображение.', 502)
      }
      const result = Buffer.from(encoded, 'base64')
      if (!result.subarray(0, 8).equals(pngSignature)) throw new PhotoProcessingError('Сервис вернул некорректный PNG.', 502)
      job.result = result
      job.expires = Date.now() + 2 * 60_000
      return { id, status: 'succeeded' }
    }
    if (['FAILED', 'TIMED_OUT', 'COMPLETED'].includes(data.status ?? '')) {
      return { id, status: 'failed', error: 'Не удалось удалить фон. Оригинал сохранён; попробуйте ещё раз.' }
    }
    throw new PhotoProcessingError('Сервис вернул неизвестное состояние задачи.', 502)
  }

  async result(id: string) {
    const job = this.owned(id)
    if (!job.result) throw new PhotoProcessingError('Изображение ещё не готово.', 409)
    return job.result
  }

  async cancel(id: string) {
    this.owned(id)
    await this.request(`cancel/${id}`, {})
    this.jobs.delete(id)
  }
}

export async function registerPhotoRoutes(app: FastifyInstance, remover: BackgroundRemover) {
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: maxBytes }, (_request, body, done) => done(null, body))
  app.get('/api/wardrobe/photos/capabilities', async () => ({ provider: 'birefnet', configured: remover.configured }))
  app.post('/api/wardrobe/photos/remove-background', { bodyLimit: maxBytes }, async (request, reply) => {
    const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new PhotoProcessingError('Ожидается фотография JPG, PNG или WebP.', 415)
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw new PhotoProcessingError('Добавьте фотографию.', 400)
    return reply.code(202).send(await remover.start(request.body, contentType))
  })
  app.get<{ Params: { id: string } }>('/api/wardrobe/photos/jobs/:id', async request => remover.status(request.params.id))
  app.get<{ Params: { id: string } }>('/api/wardrobe/photos/jobs/:id/result', async (request, reply) => reply.type('image/png').send(await remover.result(request.params.id)))
  app.post<{ Params: { id: string } }>('/api/wardrobe/photos/jobs/:id/cancel', async (request, reply) => {
    await remover.cancel(request.params.id)
    return reply.code(204).send()
  })
}
