import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { createApp } from './app.js'
import { setupFinance } from './finance/setup.js'
import { registerSharedFinance } from './finance/shared-telegram.js'
import { resolve } from 'node:path'
import { TrendMemory } from './trends/memory.js'
import { PublicSearch } from './trends/web.js'
import { OllamaPlanner, OpenRouterPlanner } from './trends/planner.js'
import { FeedCollector } from './trends/collector.js'
import { OllamaAnalyzer } from './trends/analyzer.js'
import { TrendResearchService } from './trends/service.js'
import { DEFAULT_AGENT_MODEL, RunpodPlanner } from './llm/runpod.js'
import { PlanningStore } from './planning/store.js'
import { SecretBox } from './planning/secrets.js'
import { PlanningService } from './planning/service.js'
import { DraftExtractor } from './planning/extract.js'
import { modelFromEnvironment } from './planning/model.js'
import { PlanningScheduler } from './planning/scheduler.js'
import { registerPlanningCommands } from './planning/telegram.js'
import { TelegramService } from './telegram/service.js'

if (existsSync('.env')) loadEnvFile('.env')
const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть целым числом от 1024 до 65535')
const host = process.env.API_HOST?.trim() || '127.0.0.1'
const model = process.env.TREND_LLM_MODEL?.trim()
const analyzer = model ? new OllamaAnalyzer(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined
const memory = new TrendMemory(resolve(process.env.TREND_MEMORY_PATH || 'data/trends.sqlite'))
const web = new PublicSearch(undefined, process.env.TREND_SEARXNG_URL || undefined)
const routerKey = process.env.OPENROUTER_API_KEY?.trim()
const runpodEndpoint = process.env.RUNPOD_LLM_ENDPOINT_ID?.trim()
const runpodPlanner = runpodEndpoint ? new RunpodPlanner(runpodEndpoint, process.env.RUNPOD_API_KEY?.trim() || '', process.env.RUNPOD_LLM_MODEL?.trim() || DEFAULT_AGENT_MODEL) : undefined
const planner = runpodPlanner || (routerKey ? new OpenRouterPlanner(routerKey, process.env.TREND_OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free') : model ? new OllamaPlanner(model, process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : undefined)
const service = new TrendResearchService(new FeedCollector(), analyzer, () => new Date(), { memory, web, planner })

const planningPath = resolve(process.env.PLANNING_DB_PATH || 'data/planning.sqlite')
const planningStore = new PlanningStore(planningPath, SecretBox.fromEnvironment(resolve(process.env.PLANNING_KEY_PATH || 'data/planning.key')))
// The project bot from .env starts with the service; a token saved on the website is only a fallback.
const projectBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null
const telegram = new TelegramService({ get: () => projectBotToken ?? planningStore.secret<string>('telegram-token'), set: (token) => token ? planningStore.setSecret('telegram-token', token) : planningStore.deleteSecret('telegram-token') }, fetch, undefined, Boolean(projectBotToken))
const planningModel = modelFromEnvironment()
const planning = new PlanningService(planningStore, new DraftExtractor(planningModel), { telegram, publicUrl: process.env.PLANNING_PUBLIC_URL || 'http://localhost:5173', agentModel: planningModel })
registerPlanningCommands(telegram, planning)
const scheduler = new PlanningScheduler(planning, telegram)

const wardrobeModel = process.env.WARDROBE_LLM_MODEL?.trim()
const wardrobePlanner = runpodPlanner || (routerKey
  ? new OpenRouterPlanner(routerKey, process.env.WARDROBE_OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free')
  : wardrobeModel ? new OllamaPlanner(wardrobeModel, process.env.WARDROBE_LLM_URL || process.env.TREND_LLM_URL || 'http://127.0.0.1:11434') : planner)
const financial = await setupFinance(process.env, planning)
if (financial?.bot) registerSharedFinance(telegram, financial.bot, financial.telegramPort, (chatId) => Boolean(planningStore.chatProfile(chatId)))
const app = createApp(service, { planning, wardrobePlanner, finance: financial?.finance, financeChat: financial?.chat, payments: financial?.payments })
app.addHook('onClose', async () => { financial?.payments.stop(); await financial?.store.close() })
await app.listen({ port, host })
await telegram.start()
scheduler.start()
financial?.payments.start()
console.log(`Finance: ${financial ? 'Postgres configured; shared Telegram router' : 'set DATABASE_URL to enable'}`)
console.log(`Trend research API: http://${host}:${port}`)
console.log(`AI analysis: ${planner?.provider || 'not configured; deterministic research is available'}`)
console.log(`Wardrobe stylist: ${wardrobePlanner?.provider || 'not configured'}`)
console.log(`Planning: ${planningModel ? `${planningModel.provider} ${planningModel.model} for drafts and the agent` : 'rules only (no agent)'}; Telegram ${telegram.status().running ? `@${telegram.botUsername}${telegram.managed ? ' (project bot)' : ''}` : telegram.status().error || 'not connected'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { scheduler.stop(); await telegram.stop(); await app.close(); process.exit(0) })
}
