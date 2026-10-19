import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PostgresFinanceStore } from './store.js'
import { FinanceService } from './service.js'
import { MarketService } from './market.js'
import { createDemoReceipt, seedFinanceDemo } from './demo.js'
import { PlanningService } from '../planning/service.js'
import { PlanningStore } from '../planning/store.js'
import { SecretBox } from '../planning/secrets.js'
if(existsSync('.env')) loadEnvFile('.env')
if(!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL')
const store=new PostgresFinanceStore(process.env.DATABASE_URL)
try {
  await store.migrate()
  if(process.argv.includes('--seed-demo')) {
    const now = new Date()
    const planning = new PlanningService(new PlanningStore(resolve(process.env.PLANNING_DB_PATH || 'data/planning.sqlite'), SecretBox.fromEnvironment(resolve(process.env.PLANNING_KEY_PATH || 'data/planning.key'))))
    try {
      const result = await seedFinanceDemo(store, planning, now)
      const directory = resolve('data/finance-demo')
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, 'receipt-demo.png'), await createDemoReceipt(now))
      const summary = await new FinanceService(store, new MarketService()).summary('demo')
      console.log(JSON.stringify({ ...result, quotesAvailable: summary.quotes.filter(item => item.price !== null).length, receipt: 'backend/data/finance-demo/receipt-demo.png' }))
      console.log('Демо: http://localhost:5173/?financeProfile=demo · сценарий показа: docs/finance-demo.md')
    } finally { planning.close() }
  } else console.log('Финансовые миграции применены')
} finally {await store.close()}
