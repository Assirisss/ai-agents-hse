import { RunpodHealthAssistant, UnavailableHealthAssistant, type HealthAssistant } from './ai.js'
import { HEALTH_MODEL, HealthRunpodCompletion } from './runpod.js'

type HealthAiConfiguration = { assistant: HealthAssistant; monthlyLimit: number; warning: string | null }

/** Resolve once at startup; invalid optional AI settings must not disable the diary. */
export function healthAiConfiguration(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): HealthAiConfiguration {
  const rawLimit = env.HEALTH_AI_MONTHLY_REQUEST_LIMIT?.trim() || '100'
  const validLimit = /^\d+$/.test(rawLimit) && Number(rawLimit) <= 10000
  const monthlyLimit = validLimit ? Number(rawLimit) : 0
  const endpoint = env.HEALTH_RUNPOD_ENDPOINT_ID?.trim()
  const key = env.HEALTH_RUNPOD_API_KEY?.trim() || env.RUNPOD_API_KEY?.trim()
  const invalid: string[] = []
  if (!validLimit) invalid.push('HEALTH_AI_MONTHLY_REQUEST_LIMIT: требуется целое число от 0 до 10000')
  if (endpoint && !/^[A-Za-z0-9_-]{1,80}$/.test(endpoint)) invalid.push('HEALTH_RUNPOD_ENDPOINT_ID: неверный формат')
  if (endpoint && !key) invalid.push('HEALTH_RUNPOD_API_KEY / RUNPOD_API_KEY: ключ не задан')
  if (invalid.length) return {
    assistant: new UnavailableHealthAssistant({ code: 'invalid-configuration', message: 'Тренер недоступен из-за ошибки настройки подключения. Ручной дневник работает. Проверьте настройки сервера и перезапустите его.' }),
    monthlyLimit,
    // Only fixed field names and reasons, never values or exception bodies.
    warning: `Спортивный AI отключён. ${invalid.join('; ')}`,
  }
  if (!endpoint) return { assistant: new UnavailableHealthAssistant(), monthlyLimit, warning: null }
  return {
    assistant: new RunpodHealthAssistant(new HealthRunpodCompletion(endpoint, key!, env.HEALTH_RUNPOD_MODEL?.trim() || HEALTH_MODEL, fetcher)),
    monthlyLimit,
    warning: null,
  }
}
