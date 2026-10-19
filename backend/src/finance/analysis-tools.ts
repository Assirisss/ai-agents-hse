import { z } from 'zod'
import type { FinanceAnalysisRequest } from '../../../shared/finance.js'
import type { AgentFinancePort, FinanceTool } from './tools.js'
import { analysisRequestSchema } from './analysis.js'

export const analysisToolKinds = {
  finance_compare_expenses: 'changes', finance_expense_breakdown: 'breakdown', finance_unusual_expenses: 'unusual',
  finance_recurring_expenses: 'recurring', finance_spending_scenario: 'scenario', finance_weekly_summary: 'weekly',
} as const
const descriptions: Record<keyof typeof analysisToolKinds, string> = {
  finance_compare_expenses: 'Сопоставить равные периоды: точные расходы, вклад категорий и гипотеза о разовой покупке с источниками. Без аргументов — одинаковые прошедшие дни соседних месяцев.',
  finance_expense_breakdown: 'Исследовать расходы внутри категории: группы описаний и крупнейшие записи с проверяемыми источниками. categoryId позволяет детализировать результат сравнения.',
  finance_unusual_expenses: 'Найти необычные суммы относительно 90 дней предшествующей истории и возможные дубликаты. Это кандидаты для проверки, не вывод о мошенничестве.',
  finance_recurring_expenses: 'Найти возможные еженедельные и ежемесячные платежи: минимум 3 даты, близкие суммы и одинаковое описание. Никаких автоматических подписок или записей.',
  finance_spending_scenario: 'Посчитать сокращение выбранной категории или описания на явно заданный процент; только сценарий прошлого периода, не прогноз.',
  finance_weekly_summary: 'Собрать доходы, расходы, изменение категорий и ближайшие сохранённые платежи. По умолчанию последние 7 дней, переводы исключены.',
}
export function createAnalysisTools(port: AgentFinancePort, fixed?: FinanceAnalysisRequest): FinanceTool[] {
  if (!port.analyze) return []
  return Object.entries(analysisToolKinds).filter(([, kind]) => !fixed || kind !== 'scenario' || fixed.kind === 'scenario').map(([name, kind]) => {
    // Individual tool schemas stay simple for OpenAI-compatible function calling.
    const inputSchema = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      previousFrom: z.string().optional(), previousTo: z.string().optional(), accountId: z.string().min(1).max(100).optional(),
      categoryId: z.string().min(1).max(100).optional(), query: z.string().min(3).max(200).optional(), reductionPercent: z.number().min(0).max(100).optional(),
    }).strict()
    return { name, description: descriptions[name as keyof typeof descriptions], inputSchema: z.toJSONSchema(inputSchema) as Record<string, unknown>, async execute(raw: unknown) {
      const input = inputSchema.parse(raw)
      let request: FinanceAnalysisRequest = { ...input, kind }
      if (fixed) {
        // The model may drill into a category, but cannot widen a user's account/category/description or change their dates/percentage.
        request = { ...input, ...fixed, kind }
        if (kind !== 'changes') { delete request.previousFrom; delete request.previousTo }
      }
      return port.analyze!(analysisRequestSchema.parse(request))
    } }
  })
}
