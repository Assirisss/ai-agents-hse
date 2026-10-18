import { z } from 'zod'
export const profileSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const moneySchema = z.number().int().safe().min(1).max(100_000_000_000_000)
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value }, 'Некорректная дата')
const id = z.string().min(1).max(100)
export const provenanceSchema = z.partialRecord(z.enum(['kind', 'amount', 'date', 'accountId', 'destinationAccountId', 'categoryId', 'description']), z.object({ method: z.enum(['manual', 'rule', 'model', 'receipt']), excerpt: z.string().max(500).optional(), note: z.string().max(300).optional() }).strict()).optional()
export const draftSchema = z.object({
  kind: z.enum(['income', 'expense', 'transfer']).nullable().optional(), amount: moneySchema.nullable().optional(), date: dateSchema.nullable().optional(),
  accountId: id.nullable().optional(), destinationAccountId: id.nullable().optional(), categoryId: id.nullable().optional(),
  description: z.string().trim().max(500).optional(), receiptId: id.nullable().optional(),
  items: z.array(z.object({ name: z.string().trim().max(200), quantity: z.number().positive().max(100000).nullable(), total: z.number().int().safe().nonnegative().max(100_000_000_000_000).nullable() }).strict()).max(200).optional(),
  warnings: z.array(z.string().max(300)).max(20).optional(), provenance: provenanceSchema,
}).strict()
export const operationSchema = z.object({ kind: z.enum(['income', 'expense', 'transfer']), amount: moneySchema, date: dateSchema, accountId: id,
  destinationAccountId: id.nullable().optional(), categoryId: id.nullable().optional(), description: z.string().trim().max(500).default('') }).strict()
export class FinanceError extends Error { constructor(message: string, public readonly statusCode = 400) { super(message) } }
export function moscowToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) }
