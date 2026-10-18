import { z } from 'zod'

const id = z.string().min(1).max(100)
export const garmentFields = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(['tops', 'bottoms', 'outerwear', 'dresses', 'shoes', 'bags', 'accessories']),
  color: z.enum(['black', 'white', 'grey', 'beige', 'brown', 'blue', 'green', 'red', 'pink', 'yellow', 'purple', 'multicolor']),
  season: z.enum(['all', 'spring', 'summer', 'autumn', 'winter']),
  brand: z.string().trim().max(80), notes: z.string().trim().max(1000),
}).strict()
const focus = z.string().trim().max(500).default('')
export const clientToolSchemas = {
  wardrobe_inspect_image: z.object({ imageId: id, focus }).strict(),
  wardrobe_remove_background: z.object({ imageId: id }).strict(),
  wardrobe_add_from_image: z.object({ imageId: id, focus, overrides: garmentFields.partial().default({}) }).strict(),
  wardrobe_update_garment: z.object({ garmentId: id, expectedUpdatedAt: z.iso.datetime(), changes: garmentFields.partial().refine(value => Object.keys(value).length > 0, 'Укажите изменяемые поля') }).strict(),
  wardrobe_replace_photo: z.object({ garmentId: id, expectedUpdatedAt: z.iso.datetime(), imageId: id }).strict(),
}
export type WardrobeClientToolName = keyof typeof clientToolSchemas
export type WardrobeClientCall = { id: string; name: WardrobeClientToolName; arguments: unknown }
export const imageReferenceSchema = z.object({ id, name: z.string().max(120), processing: z.enum(['original', 'background-removed']) }).strict()
export const toolReceiptSchema = z.object({ id, tool: z.string().max(80), summary: z.string().max(1000), garmentId: id.optional(), imageId: id.optional() }).strict()
export const clientToolResultSchema = z.object({
  ok: z.boolean(), error: z.string().max(1200).optional(),
  code: z.string().max(80).optional(), retryable: z.boolean().optional(),
  image: imageReferenceSchema.optional(),
  inspection: z.object({ status: z.enum(['recognized', 'needs_clarification', 'not_clothing']), draft: garmentFields.nullable(), description: z.string().max(1000), uncertainties: z.array(z.string().max(200)).max(5) }).strict().optional(),
  garment: garmentFields.extend({ id, updatedAt: z.iso.datetime() }).optional(),
  receipt: toolReceiptSchema.optional(),
}).strict()
export type WardrobeClientResult = z.infer<typeof clientToolResultSchema>
export type WardrobeToolReceipt = z.infer<typeof toolReceiptSchema>
