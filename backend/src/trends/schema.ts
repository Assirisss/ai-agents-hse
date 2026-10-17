import { z } from 'zod'

export const requestSchema = z.object({
  domain: z.enum(['all', 'planning', 'finance', 'health', 'wardrobe']).default('all'),
  query: z.string().trim().max(160).default(''),
  windowDays: z.number().int().min(1).max(30).default(7),
  limit: z.number().int().min(1).max(10).default(6),
  mode: z.enum(['demo', 'live']).default('live'),
  enableAi: z.boolean().default(false),
}).strict()

export const analysisSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  insights: z.array(z.object({
    trendId: z.string(),
    explanation: z.string().trim().min(1).max(1000),
    evidenceIds: z.array(z.string()).min(1).max(8),
  }).strict()).max(10),
}).strict()

export class ResearchError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message) }
}
