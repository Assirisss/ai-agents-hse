import type { HealthAiOperation, HealthAiReply } from '../../../shared/health.js'

/** Future providers implement this boundary; calculations and writes stay in HealthService. */
export interface HealthAssistant { run(operation: HealthAiOperation): Promise<HealthAiReply> }
export class UnavailableHealthAssistant implements HealthAssistant {
  async run(operation: HealthAiOperation): Promise<HealthAiReply> {
    return { operation, status: 'unavailable', message: 'AI пока не подключён. Введите данные вручную — дневник и расчёты уже работают.' }
  }
}
