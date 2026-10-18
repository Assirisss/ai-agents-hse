import { z } from 'zod'
import { requestSchema } from './schema.js'
import type { TrendResearchService } from './service.js'

/** A future orchestrator can register this tool without depending on the UI. */
export function createTrendTool(service: TrendResearchService) {
  return {
    name: 'search_trends',
    description: 'Персональное исследование: RSS, веб-поиск и чтение страниц при useWeb=true, профиль и долговременная память по profileId, выбор инструментов моделью при strategy=agent и enableAi=true. Вернуть основания, релевантность, даты и журнал инструментов. Live по умолчанию; demo только явно. Не подтверждает глобальную популярность.',
    inputSchema: z.toJSONSchema(requestSchema),
    execute: (input: unknown) => service.search(input),
  }
}
