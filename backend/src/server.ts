import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { createApp } from './app.js'
import { resolve } from 'node:path'
import { TrendMemory } from './trends/memory.js'
import { PublicSearch } from './trends/web.js'
import { OllamaPlanner, OpenRouterPlanner } from './trends/planner.js'
import { FeedCollector } from './trends/collector.js'
import { OllamaAnalyzer } from './trends/analyzer.js'
import { TrendResearchService } from './trends/service.js'
import { DEFAULT_AGENT_MODEL, RunpodPlanner } from './llm/runpod.js'

if (existsSync('.env')) loadEnvFile('.env')
const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть целым числом от 1024 до 65535')
const model = process.env.TREND_LLM_MODEL?.trim()
const analyzer = model ? new OllamaAnalyzer(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined
const memory = new TrendMemory(resolve(process.env.TREND_MEMORY_PATH || 'data/trends.sqlite'))
const web = new PublicSearch(undefined, process.env.TREND_SEARXNG_URL || undefined)
const routerKey = process.env.OPENROUTER_API_KEY?.trim()
const runpodEndpoint = process.env.RUNPOD_LLM_ENDPOINT_ID?.trim()
const runpodPlanner = runpodEndpoint ? new RunpodPlanner(runpodEndpoint, process.env.RUNPOD_API_KEY?.trim() || '', process.env.RUNPOD_LLM_MODEL?.trim() || DEFAULT_AGENT_MODEL) : undefined
const planner = runpodPlanner || (routerKey ? new OpenRouterPlanner(routerKey, process.env.TREND_OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free') : model ? new OllamaPlanner(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined)
const service = new TrendResearchService(new FeedCollector(), analyzer, () => new Date(), { memory, web, planner })
const wardrobeModel = process.env.WARDROBE_LLM_MODEL?.trim()
const wardrobePlanner = runpodPlanner || (routerKey
  ? new OpenRouterPlanner(routerKey, process.env.WARDROBE_OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free')
  : wardrobeModel ? new OllamaPlanner(wardrobeModel, process.env.WARDROBE_LLM_URL || process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : planner)
const app = createApp(service, undefined, wardrobePlanner)
await app.listen({ port, host: '127.0.0.1' })
console.log(`Trend research API: http://127.0.0.1:${port}`)
console.log(`AI analysis: ${planner?.provider || 'not configured; deterministic research is available'}`)
console.log(`Wardrobe stylist: ${wardrobePlanner?.provider || 'not configured'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0) })
}
