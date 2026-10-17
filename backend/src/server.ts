import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { createApp } from './app.js'
import { FeedCollector } from './trends/collector.js'
import { OllamaAnalyzer } from './trends/analyzer.js'
import { TrendResearchService } from './trends/service.js'

if (existsSync('.env')) loadEnvFile('.env')
const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть целым числом от 1024 до 65535')
const model = process.env.TREND_LLM_MODEL?.trim()
const analyzer = model ? new OllamaAnalyzer(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined
const service = new TrendResearchService(new FeedCollector(), analyzer)
const app = createApp(service)
await app.listen({ port, host: '127.0.0.1' })
console.log(`Trend research API: http://127.0.0.1:${port}`)
console.log(`AI analysis: ${analyzer ? 'configured (Ollama)' : 'not configured; deterministic research is available'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0) })
}
