import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { assessEvidence, createResearchPlan } from '../trends/quality.js'
import { evaluationCases, evaluationReport } from './fixtures.js'

let failed = 0
for (const fixture of evaluationCases) {
  const report = evaluationReport()
  const quality = assessEvidence(report, fixture.pages, createResearchPlan(report.request, ['AI agents'], report.referenceTime))
  const pass = quality.sufficient === fixture.sufficient
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${fixture.name}`)
}
console.log(`Offline evidence checks: ${evaluationCases.length - failed}/${evaluationCases.length}. This checks the verifier, not model accuracy.`)
if (failed) process.exitCode = 1
if (process.argv.includes('--live') && !failed) {
  if (existsSync('.env')) loadEnvFile('.env')
  const { OpenRouterPlanner } = await import('../trends/planner.js')
  const { TrendResearchService } = await import('../trends/service.js')
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('Для --live настройте OPENROUTER_API_KEY в локальном .env')
  const model = process.env.TREND_OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free'
  for (const enableAi of [false, true]) {
    const service = new TrendResearchService(undefined, undefined, undefined, { planner: new OpenRouterPlanner(key, model) })
    try {
      const report = await service.search({ domain: 'planning', query: 'AI agents', mode: 'live', windowDays: 30, strategy: 'agent', useWeb: true, enableAi, profileId: 'evaluation', remember: false })
      console.log(JSON.stringify({ sample: 'AI agents / 30 days', mode: enableAi ? 'model' : 'workflow', status: report.agent?.status, quality: report.agent?.quality, metrics: report.agent?.metrics }))
    } finally { service.close() }
  }
  console.log('One public live sample per mode. Repeat on held-out topics before making quality claims.')
}
