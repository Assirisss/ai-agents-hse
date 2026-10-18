/** Explicit, billable integration check. Never imported by the offline test suite. */
import assert from 'node:assert/strict'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { RunpodPlanner, DEFAULT_AGENT_MODEL } from '../dist/backend/src/llm/runpod.js'
import { WardrobeAgentService } from '../dist/backend/src/wardrobe/agent.js'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
const planner = new RunpodPlanner(process.env.RUNPOD_LLM_ENDPOINT_ID || '', process.env.RUNPOD_API_KEY || '', process.env.RUNPOD_LLM_MODEL || DEFAULT_AGENT_MODEL)
const agent = new WardrobeAgentService(planner)
const today = new Date().toISOString().slice(0, 10)
const reply = await agent.chat({
  message: 'Назови мои вещи категории «верх». Используй данные гардероба, отвечай кратко по-русски.',
  history: [], today, allowTrends: false, trendTopic: 'повседневный гардероб',
  snapshot: {
    garments: [{ id: 'test-shirt', name: 'Белая футболка', category: 'tops', color: 'white', season: 'all', brand: '', notes: '', updatedAt: `${today}T10:00:00Z` }],
    outfits: [], wears: [], wishlist: [], totals: { garments: 1, outfits: 0, wears: 0, wishlist: 0 },
  },
}, AbortSignal.timeout(290000))
console.log(JSON.stringify({ provider: reply.provider, status: reply.status, text: reply.text, tools: reply.trace.map(step => ({ name: step.tool, status: step.status })) }, null, 2))
assert.equal(reply.status, 'completed')
assert.equal(reply.provider, 'runpod')
assert.equal(reply.actions.length, 0)
assert.ok(reply.trace.some(step => step.tool === 'wardrobe_search' && step.status === 'ok'), 'Agent must read the real test wardrobe')
assert.ok(/футболк/i.test(reply.text), 'Agent must name the actual test garment')
console.log('PASS: Runpod model → wardrobe tool → grounded Russian reply.')
