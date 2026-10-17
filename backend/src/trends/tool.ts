import { z } from 'zod'
import { requestSchema } from './schema.js'
import type { TrendResearchService } from './service.js'

/** A future orchestrator can register this tool without depending on the UI. */
export function createTrendTool(service: TrendResearchService) {
  return {
    name: 'search_trends',
    description: 'Собрать материалы из настроенных RSS-источников по области и запросу, найти сигналы роста упоминаний в выборке, вернуть даты и доказательства. Live по умолчанию; demo только по явному запросу. Не подтверждает глобальную популярность.',
    inputSchema: z.toJSONSchema(requestSchema),
    execute: (input: unknown) => service.search(input),
  }
}
