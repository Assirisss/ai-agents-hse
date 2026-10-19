import { z } from 'zod'
import { readLimitedText } from '../trends/http.js'
import { HealthError } from './schema.js'

export const HEALTH_MODEL = 'Qwen/Qwen3-VL-8B-Instruct'
export type CompletionInput = { system: string; text: string; image?: string; schema: Record<string, unknown> }
export type CompletionOutput = { text: string; model: string; promptTokens: number | null; completionTokens: number | null; delayMs: number | null; executionMs: number | null }
export interface HealthCompletion { readonly model: string; complete(input: CompletionInput, signal: AbortSignal): Promise<CompletionOutput> }
const envelopeSchema = z.object({ model: z.string().optional(), choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().min(1).max(40000) }) })).length(1), usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional() })
const pause = (signal: AbortSignal, ms: number) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true })
})
const milliseconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** One paid submission, bounded polling, best-effort cancellation. No provider fallback. */
export class HealthRunpodCompletion implements HealthCompletion {
  private readonly base: string
  constructor(endpoint: string, private readonly key: string, readonly model = HEALTH_MODEL, private readonly fetcher: typeof fetch = fetch, private readonly pollMs = 1000, private readonly timeoutMs = 300000) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(endpoint) || !key.trim()) throw new Error('Настройте HEALTH_RUNPOD_ENDPOINT_ID и RUNPOD_API_KEY')
    this.base = `https://api.runpod.ai/v2/${endpoint}`
  }
  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await this.fetcher(`${this.base}/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new HealthError(response.status === 401 || response.status === 403 ? 'Ключ Runpod не принят. Проверьте настройки backend.' : response.status === 429 ? 'Runpod перегружен. Повторите запрос позже.' : 'Runpod недоступен. Проверьте endpoint и баланс.', 503)
    }
    return z.record(z.string(), z.unknown()).parse(JSON.parse(await readLimitedText(response, 256000)))
  }
  async complete(input: CompletionInput, signal: AbortSignal): Promise<CompletionOutput> {
    signal.throwIfAborted()
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    let jobId: string | undefined, terminal = false
    try {
      const content = input.image ? [{ type: 'text', text: input.text }, { type: 'image_url', image_url: { url: input.image } }] : input.text
      // Receive the id even if the browser disconnects during submission, then cancel it.
      let job = await this.request('run', AbortSignal.timeout(30000), { input: { openai_route: '/v1/chat/completions', openai_input: {
        model: this.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content }], temperature: 0, max_tokens: 3000, stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'health_draft', strict: true, schema: input.schema } },
      } }, policy: { executionTimeout: 90000, ttl: 300000 } })
      jobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(job.id)
      while (true) {
        active.throwIfAborted()
        if (job.status === 'COMPLETED') { terminal = true; break }
        if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(job.status))) { terminal = true; throw new HealthError('Модель не завершила запрос. Проверьте endpoint; повтор запускается только вручную.', 503) }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(String(job.status))) throw new HealthError('Runpod вернул неизвестный статус задачи.', 502)
        await pause(active, this.pollMs)
        job = await this.request(`status/${jobId}`, active)
      }
      let output: unknown = job.output
      if (Array.isArray(output) && output.length === 1) output = output[0]
      if (typeof output === 'string') output = JSON.parse(output)
      const envelope = envelopeSchema.parse(output)
      if (envelope.choices[0].finish_reason !== 'stop') throw new HealthError('Модель вернула незавершённый ответ. Сократите описание и повторите запрос.', 502)
      return { text: envelope.choices[0].message.content, model: envelope.model || this.model, promptTokens: envelope.usage?.prompt_tokens ?? null, completionTokens: envelope.usage?.completion_tokens ?? null, executionMs: milliseconds(job.executionTime), delayMs: milliseconds(job.delayTime) }
    } catch (error) {
      if (active.aborted) throw new HealthError(signal.aborted ? 'Запрос отменён.' : 'Время ожидания Runpod истекло. Запрос отменяется; повторите его вручную.', 408)
      if (error instanceof HealthError) throw error
      throw new HealthError('Не удалось получить корректный ответ Runpod. Автоматического повтора нет.', 502)
    } finally {
      if (jobId && !terminal) await this.request(`cancel/${jobId}`, AbortSignal.timeout(10000), {}).catch(() => undefined)
    }
  }
}
