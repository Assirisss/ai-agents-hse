import { z } from 'zod'
import type { Account, Category, Draft, DraftInput, FinanceStats, Operation, OperationKind } from '../../../shared/finance.js'

type Awaitable<T> = T | Promise<T>
export type OperationFilters = { from?: string; to?: string; kind?: OperationKind; accountId?: string; categoryId?: string; query?: string }
/** The server binds this port to the authenticated profile before exposing any tools. */
export interface AgentFinancePort {
  accounts(): Awaitable<Account[]>
  categories(): Awaitable<Category[]>
  drafts?(): Awaitable<Draft[]>
  operations(filters: OperationFilters): Awaitable<Operation[]>
  stats(range: { from: string; to: string }): Awaitable<FinanceStats>
  createDraft(input: DraftInput, source: 'text' | 'receipt'): Awaitable<Draft>
  updateDraft(id: string, input: DraftInput): Awaitable<Draft>
}

export const financeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const parsed = new Date(`${date}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}, 'Укажите существующую дату YYYY-MM-DD')
const identifier = z.string().trim().min(1).max(100)
const amount = z.number().int().positive().max(100_000_000_000_000)
export const receiptItemSchema = z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().positive().max(100000).nullable(), total: z.number().int().nonnegative().max(100_000_000_000_000).nullable() }).strict()
export const financeDraftSchema = z.object({
  kind: z.enum(['income', 'expense', 'transfer']).nullable().optional(),
  amount: amount.nullable().optional(),
  date: financeDateSchema.nullable().optional(),
  accountId: identifier.nullable().optional(),
  destinationAccountId: identifier.nullable().optional(),
  categoryId: identifier.nullable().optional(),
  description: z.string().max(500).optional(),
}).strict()
const rangeSchema = z.object({ from: financeDateSchema, to: financeDateSchema }).strict().refine(({ from, to }) => from <= to, 'Начало периода должно предшествовать окончанию')
const filtersSchema = z.object({ from: financeDateSchema.optional(), to: financeDateSchema.optional(), kind: z.enum(['income', 'expense', 'transfer']).optional(), accountId: identifier.optional(), categoryId: identifier.optional(), query: z.string().max(200).optional() }).strict().refine(({ from, to }) => !from || !to || from <= to, 'Неверный период')

export type FinanceTool = { name: string; description: string; inputSchema: Record<string, unknown>; execute(input: unknown): Promise<unknown> }

async function validateReferences(port: AgentFinancePort, input: DraftInput) {
  if (input.accountId || input.destinationAccountId) {
    const accounts = await port.accounts()
    for (const id of [input.accountId, input.destinationAccountId].filter(Boolean)) {
      if (!accounts.some((account) => account.id === id && !account.archived)) throw new Error('Счёт не найден или архивирован. Выберите счёт пользователя.')
    }
    if (input.accountId && input.accountId === input.destinationAccountId) throw new Error('Для перевода нужны разные счета.')
  }
  if (input.categoryId) {
    const category = (await port.categories()).find((item) => item.id === input.categoryId)
    if (!category || (input.kind && input.kind !== category.kind)) throw new Error('Категория не подходит операции.')
  }
}

/** Safe for the general assistant: neither profile selectors nor confirmation are model arguments. */
export function createFinanceTools(port: AgentFinancePort): FinanceTool[] {
  const tool = <T>(name: string, description: string, schema: z.ZodType<T>, execute: (input: T) => Awaitable<unknown>): FinanceTool => ({
    name, description, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    async execute(input) { return execute(schema.parse(input)) },
  })
  return [
    tool('finance_accounts', 'Счета и точные остатки в целых копейках RUB. Только данные текущего пользователя.', z.object({}).strict(), () => port.accounts()),
    tool('finance_categories', 'Категории текущего пользователя с ID и типом доход/расход.', z.object({}).strict(), () => port.categories()),
    tool('finance_operations', 'Подтверждённые операции текущего пользователя. Суммы в копейках; максимум 100 последних операций.', filtersSchema, async (input) => (await port.operations(input)).sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)).slice(0, 100)),
    tool('finance_stats', 'Точные доходы, расходы и сравнение с предыдущим периодом. Суммы рассчитывает сервер, в копейках.', rangeSchema, (input) => port.stats(input)),
    tool('finance_create_draft', 'Создать черновик, НЕ запись в учёте. Суммы только из сообщения в целых копейках. Неполные поля оставлять null. Подтверждает только пользователь.', financeDraftSchema, async (input) => {
      await validateReferences(port, input)
      return port.createDraft(input, 'text')
    }),
    tool('finance_update_draft', 'Уточнить существующий черновик по явно указанному ID. Не подтверждает операцию.', z.object({ id: identifier, input: financeDraftSchema }).strict(), async ({ id, input }) => {
      await validateReferences(port, input)
      return port.updateDraft(id, input)
    }),
  ]
}
