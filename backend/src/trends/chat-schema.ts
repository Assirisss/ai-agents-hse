import { z } from 'zod'
import { profileIdSchema } from './schema.js'
export const conversationParams = z.object({ profileId: profileIdSchema, id: z.string().uuid() })
export const briefSchema = z.object({
  query: z.string().trim().max(160).optional(),
  domain: z.enum(['all', 'planning', 'finance', 'health', 'wardrobe']).optional(),
  windowDays: z.number().int().min(1).max(30).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Нужно указать хотя бы один параметр')
export const chatRequestSchema = z.object({
  turnId: z.string().uuid(), expectedRevision: z.number().int().min(0), text: z.string().trim().min(1).max(4000),
  mode: z.enum(['demo', 'live']).default('live'), enableAi: z.boolean().default(true),
  useWeb: z.boolean().default(true), useModuleContext: z.boolean().default(true),
}).strict()
export const sourceFilterSchema = z.object({
  query: z.string().trim().max(160).optional(), onlyDated: z.boolean().optional(), onlyRecent: z.boolean().optional(), onlyRead: z.boolean().optional(),
  publisher: z.string().trim().max(200).optional(), kind: z.enum(['rss', 'news', 'paper', 'page']).optional(), limit: z.number().int().min(1).max(20).default(8),
}).strict()
export const reportArgs = z.object({ reportId: z.string().uuid().optional() }).strict()
export const filterArgs = sourceFilterSchema.extend({ reportId: z.string().uuid().optional(), reset: z.boolean().optional() })
export const inspectArgs = z.object({ sourceId: z.string().min(1).max(150), reportId: z.string().uuid().optional() }).strict()
export const compareArgs = z.object({ leftId: z.string().uuid(), rightId: z.string().uuid() }).strict()
export const finishChatSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  citations: z.array(z.object({ sourceId: z.string().min(1).max(150), reportId: z.string().uuid() }).strict()).max(8).default([]),
}).strict()
