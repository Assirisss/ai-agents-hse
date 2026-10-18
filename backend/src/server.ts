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

if (existsSync('.env')) loadEnvFile('.env')
const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть целым числом от 1024 до 65535')
const model = process.env.TREND_LLM_MODEL?.trim()
const analyzer = model ? new OllamaAnalyzer(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined
const memory = new TrendMemory(resolve(process.env.TREND_MEMORY_PATH || 'data/trends.sqlite'))
const web = new PublicSearch(undefined, process.env.TREND_SEARXNG_URL || undefined)
const routerKey = process.env.OPENROUTER_API_KEY?.trim()
const planner = routerKey ? new OpenRouterPlanner(routerKey, process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free') : model ? new OllamaPlanner(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined
const service = new TrendResearchService(new FeedCollector(), analyzer, () => new Date(), { memory, web, planner })
const app = createApp(service)
await app.listen({ port, host: '127.0.0.1' })
console.log(`Trend research API: http://127.0.0.1:${port}`)
console.log(`AI analysis: ${planner?.provider || 'not configured; deterministic research is available'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0) })
}
