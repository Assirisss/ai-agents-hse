import { z } from 'zod'
import { readLimitedText } from './http.js'

export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCall = { id?: string; name: string; arguments: unknown }
export type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_name?: string
  tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[]
}
export type PlannerResult = { content: string; calls: ToolCall[]; model?: string; usage?: { promptTokens: number; completionTokens: number; costUsd: number | null } }
export interface ResearchPlanner {
  readonly provider?: string
  forRun?(): ResearchPlanner
  next(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal, onStatus?: (status: 'queued' | 'running') => void): Promise<PlannerResult>
}

export class OllamaPlanner implements ResearchPlanner {
  readonly provider = 'ollama'
  constructor(private model: string, private baseUrl = 'http://127.0.0.1:11434', private fetcher: typeof fetch = fetch) {}
  async next(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal) {
    const response = await this.fetcher(new URL('/api/chat', this.baseUrl), {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, stream: false, messages, tools: tools.map((tool) => ({ type: 'function', function: tool })), options: { temperature: 0, num_predict: 1400 } }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Планировщик ответил HTTP ${response.status}`) }
    const envelope = z.object({ message: z.object({ content: z.string().default(''), tool_calls: z.array(z.object({ function: z.object({ name: z.string().max(80), arguments: z.unknown() }) })).max(12).optional() }) })
      .parse(JSON.parse(await readLimitedText(response, 128000)))
    return { content: envelope.message.content.slice(0, 4000), calls: (envelope.message.tool_calls || []).map((call) => ({ name: call.function.name, arguments: call.function.arguments })) }
  }
}

/** OpenRouter chat completions; tools execute on our server, never through paid search plugins. */
export class OpenRouterPlanner implements ResearchPlanner {
  readonly provider = 'openrouter'
  private selectedFreeModel?: string
  private pinFreeModel = false
  constructor(private apiKey: string, private model = 'openrouter/free', private fetcher: typeof fetch = fetch) {}
  forRun(): ResearchPlanner {
    const planner = new OpenRouterPlanner(this.apiKey, this.model, this.fetcher)
    planner.pinFreeModel = true
    return planner
  }
  async next(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal) {
    const transport = messages.map((message) => message.role === 'tool'
      ? { role: 'tool', tool_call_id: message.tool_call_id, content: message.content }
      : { role: message.role, content: message.content, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) } })) } : {}) })
    const response = await this.fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, 'X-OpenRouter-Title': 'AI Agents HSE - Trend research' },
      body: JSON.stringify({ model: this.selectedFreeModel || this.model, messages: transport, tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: tools.length === 1 && ['finish_research', 'finish_chat'].includes(tools[0].name) ? { type: 'function', function: { name: tools[0].name } } : 'auto', temperature: 0, max_tokens: 1800, provider: { require_parameters: true } }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenRouter ответил HTTP ${response.status}`) }
    const envelope = z.object({ model: z.string().optional(), usage: z.object({ prompt_tokens: z.number().nonnegative().default(0), completion_tokens: z.number().nonnegative().default(0), cost: z.number().nonnegative().optional() }).optional(), choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.object({ id: z.string().min(1).max(200), function: z.object({ name: z.string().max(80), arguments: z.string().max(16000) }) })).max(12).optional() }) })).min(1) })
      .parse(JSON.parse(await readLimitedText(response, 128000)))
    if (this.pinFreeModel && this.model === 'openrouter/free' && !this.selectedFreeModel && envelope.model?.endsWith(':free')) this.selectedFreeModel = envelope.model
    const message = envelope.choices[0].message
    return { model: envelope.model, usage: envelope.usage ? { promptTokens: envelope.usage.prompt_tokens, completionTokens: envelope.usage.completion_tokens, costUsd: envelope.usage.cost ?? null } : undefined, content: (message.content || '').slice(0, 4000), calls: (message.tool_calls || []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) }
  }
}
