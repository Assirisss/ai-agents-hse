import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { setupFinance } from './setup.js'
if (existsSync('.env')) loadEnvFile('.env')
const setup = await setupFinance()
if (!setup?.worker) { await setup?.store.close(); throw new Error('Для worker нужны DATABASE_URL и TELEGRAM_BOT_TOKEN') }
// The API's shared project bot owns getUpdates. This process schedules deliveries only.
const stop = setup.worker.start()
console.log('Finance worker: daily summary at 21:00 Europe/Moscow; Telegram updates are handled by the API')
await new Promise<void>((resolve) => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, resolve)
  // Keep this worker alive even though the scheduler interval itself is unref'ed.
  const keepAlive = setInterval(() => undefined, 60_000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => clearInterval(keepAlive))
})
stop()
await setup.store.close()
