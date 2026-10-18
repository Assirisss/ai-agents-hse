import { z } from 'zod'
import { readLimitedText } from '../trends/http.js'

/** A single structured-output call: used to segment free text into items. */
export interface JsonModel {
  readonly provider: 'ollama' | 'openrouter'
  readonly model: string
  complete(system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCallRequest = { id: string; name: string; arguments: unknown }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; calls?: ToolCallRequest[] }
  | { role: 'tool'; content: string; callId: string; name: string }

/**
 * One step of the planning agent: the model either calls tools or answers.
 * Tools run on our server; the model never writes data directly.
 * Kept inside the planning module so changes in the trend planner do not affect it.
 */
export interface ToolModel {
  readonly provider: 'ollama' | 'openrouter'
  readonly model: string
  chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<{ content: string; calls: ToolCallRequest[] }>
}
export type PlanningModel = JsonModel & ToolModel

function parseJson(content: string) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(text) as unknown
}
const parseArguments = (value: unknown) => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

/** Local Ollama: `format` constrains decoding to the JSON schema, which keeps small models on track. */
export class OllamaJsonModel implements PlanningModel {
  readonly provider = 'ollama'
  constructor(readonly model: string, private baseUrl = 'http://127.0.0.1:11434', private fetcher: typeof fetch = fetch, private timeoutMs = 90000) {}

  private async post(body: Record<string, unknown>, signal: AbortSignal) {
    const response = await this.fetcher(new URL('/api/chat', this.baseUrl), {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), headers: { 'Content-Type': 'application/json' },
      // think: false — reasoning traces of qwen3-like models make each step several times slower.
      body: JSON.stringify({ model: this.model, stream: false, think: false, ...body }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Ollama ответила HTTP ${response.status}`) }
    return z.object({ message: z.object({ content: z.string().default(''), tool_calls: z.array(z.object({ function: z.object({ name: z.string().max(80), arguments: z.unknown() }) })).max(12).optional() }) })
      .parse(JSON.parse(await readLimitedText(response, 128000))).message
  }

  async complete(system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal) {
    const message = await this.post({ format: schema, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { temperature: 0, num_predict: 900 } }, signal)
    return parseJson(message.content)
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal) {
    const transport = messages.map((message) => message.role === 'tool' ? { role: 'tool', content: message.content, tool_name: message.name }
      : message.role === 'assistant' ? { role: 'assistant', content: message.content, ...(message.calls?.length ? { tool_calls: message.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}) }
        : message)
    const reply = await this.post({ messages: transport, tools: tools.map((tool) => ({ type: 'function', function: tool })), options: { temperature: 0, num_predict: 1500 } }, signal)
    return { content: reply.content.slice(0, 6000), calls: (reply.tool_calls || []).map((call, index) => ({ id: `call-${Date.now()}-${index}`, name: call.function.name, arguments: parseArguments(call.function.arguments) })) }
  }
}

export class OpenRouterJsonModel implements PlanningModel {
  readonly provider = 'openrouter'
  constructor(private apiKey: string, readonly model = 'openrouter/free', private fetcher: typeof fetch = fetch) {}

  private async post(body: Record<string, unknown>, signal: AbortSignal) {
    const response = await this.fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, 'X-OpenRouter-Title': 'AI Agents HSE - Planning' },
      body: JSON.stringify({ model: this.model, temperature: 0, ...body }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenRouter ответил HTTP ${response.status}`) }
    return z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.object({ id: z.string().max(200), function: z.object({ name: z.string().max(80), arguments: z.string().max(16000) }) })).max(12).optional() }) })).min(1) })
      .parse(JSON.parse(await readLimitedText(response, 128000))).choices[0].message
  }

  async complete(system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal) {
    const message = await this.post({ max_tokens: 900, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_schema', json_schema: { name: 'planning_extraction', strict: true, schema } } }, signal)
    return parseJson(message.content || '')
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal) {
    const transport = messages.map((message) => message.role === 'tool' ? { role: 'tool', tool_call_id: message.callId, content: message.content }
      : message.role === 'assistant' ? { role: 'assistant', content: message.content, ...(message.calls?.length ? { tool_calls: message.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) } : {}) }
        : message)
    const reply = await this.post({ max_tokens: 1500, messages: transport, tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto', provider: { require_parameters: true } }, signal)
    return { content: (reply.content || '').slice(0, 6000), calls: (reply.tool_calls || []).map((call) => ({ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) })) }
  }
}

/** Local model first: PLANNING_LLM_MODEL or TREND_LLM_MODEL for Ollama, then OpenRouter if a key exists. */
export function modelFromEnvironment(env = process.env): PlanningModel | undefined {
  const local = env.PLANNING_LLM_MODEL?.trim() || env.TREND_LLM_MODEL?.trim()
  const url = env.PLANNING_LLM_URL?.trim() || env.TREND_LLM_URL?.trim() || 'http://127.0.0.1:11434'
  if (env.PLANNING_LLM === 'off') return undefined
  if (local && env.PLANNING_LLM !== 'openrouter') return new OllamaJsonModel(local, url)
  const key = env.OPENROUTER_API_KEY?.trim()
  if (key) return new OpenRouterJsonModel(key, env.OPENROUTER_MODEL?.trim() || 'openrouter/free')
  return undefined
}
