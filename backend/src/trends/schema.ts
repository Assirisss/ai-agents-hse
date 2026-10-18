import { z } from 'zod'

export const requestSchema = z.object({
  domain: z.enum(['all', 'planning', 'finance', 'health', 'wardrobe']).default('all'),
  query: z.string().trim().max(160).default(''),
  windowDays: z.number().int().min(1).max(30).default(7),
  limit: z.number().int().min(1).max(10).default(6),
  mode: z.enum(['demo', 'live']).default('live'),
  enableAi: z.boolean().default(false),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('default'),
  useWeb: z.boolean().default(false),
  strategy: z.enum(['workflow', 'agent']).default('workflow'),
  useModuleContext: z.boolean().default(true),
  remember: z.boolean().default(true),
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

export const profileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const lines = z.array(z.string().trim().min(1).max(200)).max(20)
export const profileSchema = z.object({
  interests: lines.default([]), goals: lines.default([]), context: lines.default([]),
  excludedTopics: lines.default([]), experience: z.string().trim().max(300).default(''),
  allowInterestQueries: z.boolean().default(false),
}).strict()
export const finishSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  findings: z.array(z.object({
    title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(1000),
    whyRelevant: z.string().trim().min(1).max(700), evidenceIds: z.array(z.string()).min(1).max(8),
    supportingQuotes: z.array(z.object({ evidenceId: z.string(), quote: z.string().trim().min(12).max(240) }).strict()).max(2).optional(),
  }).strict()).max(8),
}).strict()

export const moduleContextSchema = z.object({
  module: z.enum(['planning', 'finance', 'health', 'wardrobe']),
  source: z.string().trim().min(1).max(100),
  facts: z.array(z.string().trim().min(1).max(200)).max(30),
}).strict()
