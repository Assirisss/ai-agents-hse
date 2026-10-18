import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { PostgresFinanceStore, emptyFinance } from './store.js'
import { FinanceService } from './service.js'
import { moscowToday } from './schema.js'
if(existsSync('.env')) loadEnvFile('.env')
if(!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL')
const store=new PostgresFinanceStore(process.env.DATABASE_URL)
try {
  await store.migrate()
  if(process.argv.includes('--seed-demo')) {
    // Explicitly reset only the dedicated demo profile; never default or Telegram bindings.
    await store.transact('demo',value=>Object.assign(value,emptyFinance()))
    const service=new FinanceService(store)
    await service.createAccount('demo',{name:'Карта',initialBalance:1500000})
    const today=moscowToday()
    for(const input of [{kind:'income',amount:10000000,date:today,accountId:'cash',categoryId:'salary',description:'Демонстрационная зарплата'},{kind:'expense',amount:125050,date:today,accountId:'cash',categoryId:'food',description:'Демонстрационные продукты'}]) {const draft=await service.createDraft('demo',input);await service.confirmDraft('demo',draft.id)}
    console.log('Профиль demo сброшен и заполнен искусственными данными. Передайте ?profileId=demo в API.')
  } else console.log('Финансовые миграции применены')
} finally {await store.close()}
