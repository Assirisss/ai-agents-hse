import { z } from 'zod'
import { dateSchema, identifier, nutrientsSchema } from './schema.js'

const text = z.string().trim().max(4000)
const location = z.enum(['home', 'gym', 'outdoors', 'other'])
export const healthAiInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('parse-workout'), text: text.min(1), date: dateSchema }).strict(),
  z.object({ operation: z.literal('recognize-food'), text: text.default(''), photo: z.string().max(8 * 1024 * 1024 + 100), mode: z.enum(['dish', 'label']), date: dateSchema }).strict(),
  z.object({ operation: z.literal('explain-progress'), to: dateSchema, days: z.union([z.literal(7), z.literal(30), z.literal(90)]), exerciseId: identifier.optional() }).strict(),
  z.object({ operation: z.literal('suggest-workout'), text: text.min(1), date: dateSchema, location, minutes: z.number().int().min(5).max(180), equipment: z.string().trim().min(1).max(500), experience: z.enum(['beginner', 'regular']) }).strict(),
])
const name = z.string().trim().min(1).max(120)
const common = { message: z.string().max(2000), questions: z.array(z.string().min(1).max(300)).max(8), warnings: z.array(z.string().min(1).max(300)).max(8) }
const nullableNumber = (min: number, max: number) => z.number().finite().min(min).max(max).nullable()
export const workoutReplySchema = z.object({ ...common, workout: z.object({ name, location, entries: z.array(z.object({
  exerciseId: identifier.nullable(), name, kind: z.enum(['strength', 'cardio']), bodyweight: z.boolean(),
  sets: z.array(z.object({ reps: z.number().int().min(1).max(1000).nullable(), weight: nullableNumber(0, 2000) }).strict()).max(20),
  minutes: nullableNumber(0.01, 10080), distanceKm: nullableNumber(0.001, 2000),
}).strict()).max(20) }).strict() }).strict()
export const foodReplySchema = z.object({ ...common, food: z.object({ name,
  components: z.array(z.object({ name, productId: identifier.nullable(), estimatedGrams: nullableNumber(0.01, 100000) }).strict()).max(20),
  label: z.object({ name, brand: z.string().max(120), per100: nutrientsSchema.strict() }).strict().nullable(),
}).strict() }).strict()
export const progressReplySchema = z.object({ ...common, observations: z.array(z.object({ factId: identifier, text: z.string().min(1).max(800) }).strict()).max(12) }).strict()
