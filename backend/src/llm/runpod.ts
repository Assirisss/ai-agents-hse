import { z } from 'zod'
import type { AgentMessage, PlannerResult, ResearchPlanner, ToolDefinition } from '../trends/planner.js'
import { readLimitedText } from '../trends/http.js'
import { classifyProviderError, ModelError } from './errors.js'

export const DEFAULT_AGENT_MODEL = 'Qwen/Qwen3-4B-Instruct-2507'
const jobIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const completionSchema = z.object({
  model: z.string().optional(),
  usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative() }).optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ id: z.string().min(1).max(200), function: z.object({ name: z.string().min(1).max(80), arguments: z.string().max(16000) }) })).max(12).optional(),
  }) })).min(1),
})

function transportMessages(messages: AgentMessage[]) {
  return messages.map(message => message.role === 'tool'
    ? { role: 'tool', tool_call_id: message.tool_call_id, content: message.content }
    : { role: message.role, content: message.content, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({
      id: call.id, type: 'function', function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) },
    })) } : {}) })
}

function pause(signal: AbortSignal, delay = 1000) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Shared agent brain. Queue transport tolerates cold starts and submits each turn once. */
export class RunpodPlanner implements ResearchPlanner {
  readonly provider = 'runpod'
  private readonly baseUrl: string

  constructor(endpointId: string, private readonly apiKey: string, private readonly model = DEFAULT_AGENT_MODEL, private readonly fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(endpointId) || !apiKey.trim()) throw new Error('Настройте RUNPOD_LLM_ENDPOINT_ID и RUNPOD_API_KEY.')
    this.baseUrl = `https://api.runpod.ai/v2/${endpointId}`
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.baseUrl}/${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) { await response.body?.cancel(); throw response.status === 401 || response.status === 403 ? new ModelError('credentials', 'Ключ Runpod не принят. Проверьте настройки backend.') : response.status === 429 ? new ModelError('rate_limit', 'Runpod временно ограничил запросы. Попробуйте позже.') : new ModelError('unavailable', `Runpod LLM ответил HTTP ${response.status}`) }
    const value: unknown = JSON.parse(await readLimitedText(response, 256000))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Runpod LLM вернул некорректный ответ.')
    return value as Record<string, unknown>
  }

  async next(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal, onStatus?: (status: 'queued' | 'running') => void): Promise<PlannerResult> {
    signal.throwIfAborted()
    let jobId: string | undefined
    let terminal = false
    const active = AbortSignal.any([signal, AbortSignal.timeout(300000)])
    try {
      const finalTool = tools.length === 1 && ['finish_research', 'wardrobe_finish'].includes(tools[0].name)
      const completion = {
        model: this.model, messages: transportMessages(messages), stream: false,
        temperature: 0, max_tokens: 1200,
        ...(tools.length ? {
          tools: tools.map(tool => ({ type: 'function', function: tool })),
          tool_choice: finalTool ? { type: 'function', function: { name: tools[0].name } } : 'auto', parallel_tool_calls: false,
        } : {}),
      }
      // Do not abort submission mid-flight: receive its id first so cancellation
      // can stop a remote job even if the user closed the UI during submission.
      let job = await this.request('run', AbortSignal.timeout(30000), {
        input: { openai_route: '/v1/chat/completions', openai_input: completion },
        policy: { executionTimeout: 90000, ttl: 300000 },
      })
      if (typeof job.id !== 'string' || !jobIdPattern.test(job.id)) throw new Error('Runpod LLM не вернул ID задачи.')
      jobId = job.id
      let previousStatus: unknown
      while (true) {
        active.throwIfAborted()
        if (job.status !== previousStatus && ['IN_QUEUE', 'IN_PROGRESS'].includes(String(job.status))) onStatus?.(job.status === 'IN_QUEUE' ? 'queued' : 'running')
        previousStatus = job.status
        if (job.status === 'COMPLETED') { terminal = true; break }
        if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(job.status))) {
          terminal = true
          throw classifyProviderError(job.error)
        }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(String(job.status))) throw new Error('Runpod LLM вернул неизвестное состояние задачи.')
        await pause(active, job.status === 'IN_PROGRESS' ? 300 : 1000)
        job = await this.request(`status/${jobId}`, active)
      }
      let output: unknown = job.output
      // The official worker is an async generator, so Runpod may wrap its one
      // non-streamed OpenAI response in an array.
      if (Array.isArray(output) && output.length === 1) output = output[0]
      if (typeof output === 'string') output = JSON.parse(output)
      if (output && typeof output === 'object' && 'error' in output) throw classifyProviderError((output as { error: unknown }).error)
      const envelope = completionSchema.parse(output)
      if (envelope.choices[0].finish_reason === 'length') throw new ModelError('invalid_response', 'Ответ модели достиг лимита длины. Уточните или сократите запрос.')
      const message = envelope.choices[0].message
      return {
        model: envelope.model || this.model,
        usage: envelope.usage ? { promptTokens: envelope.usage.prompt_tokens, completionTokens: envelope.usage.completion_tokens, costUsd: null } : undefined,
        content: (message.content || '').slice(0, 4000),
        calls: (message.tool_calls || []).map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      }
    } catch (cause) {
      if (active.aborted) throw active.reason
      if (cause instanceof ModelError) throw cause
      // Never forward provider response bodies, prompts or credentials to the UI.
      if (cause instanceof Error && cause.message.startsWith('Runpod LLM')) throw cause
      if (cause instanceof Error && cause.message.startsWith('Ответ модели')) throw cause
      throw new Error('Не удалось получить корректный ответ Runpod LLM. Повторите запрос явно.')
    } finally {
      if (jobId && !terminal) {
        // Best effort: no retries and no fallback to another paid provider.
        await this.request(`cancel/${jobId}`, AbortSignal.timeout(10000), {}).catch(() => undefined)
      }
    }
  }
}
