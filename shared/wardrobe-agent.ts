import type { WardrobeClientCall, WardrobeToolReceipt } from './wardrobe-tools'
/** JSON-only chat boundary. Image tools upload copies through separate endpoints. */
export type WardrobeCategory = 'tops' | 'bottoms' | 'outerwear' | 'dresses' | 'shoes' | 'bags' | 'accessories'
export type WardrobeGarmentDraft = {
  name: string
  category: WardrobeCategory
  color: 'black' | 'white' | 'grey' | 'beige' | 'brown' | 'blue' | 'green' | 'red' | 'pink' | 'yellow' | 'purple' | 'multicolor'
  season: 'all' | 'spring' | 'summer' | 'autumn' | 'winter'
  brand: string
  notes: string
}
export type AgentGarment = WardrobeGarmentDraft & { id: string; updatedAt: string }
export type AgentOutfit = { id: string; name: string; notes: string; garmentIds: string[]; updatedAt: string }
export type AgentWear = { date: string; outfitId: string; garmentIds: string[] }
export type WardrobePurchaseDraft = {
  name: string; category: WardrobeCategory; priceMinor: number | null; currency: 'RUB' | 'USD' | 'EUR'
  priority: 'high' | 'normal' | 'low'; url: string; notes: string
}
export type AgentPurchase = WardrobePurchaseDraft & { id: string; status: 'planned' | 'purchased' }
export type WardrobeSnapshot = {
  garments: AgentGarment[]; outfits: AgentOutfit[]; wears: AgentWear[]; wishlist: AgentPurchase[]
  totals: { garments: number; outfits: number; wears: number; wishlist: number }
}
export type WardrobeAction = { id: string; reason: string } & (
  | { kind: 'outfit'; name: string; notes: string; garmentIds: string[] }
  | { kind: 'purchase'; draft: WardrobePurchaseDraft }
  | { kind: 'garment'; draft: WardrobeGarmentDraft }
  | { kind: 'update'; garmentId: string; expectedUpdatedAt: string; draft: WardrobeGarmentDraft; replacePhoto?: boolean }
  | { kind: 'wear'; outfitId: string; outfitName: string; expectedUpdatedAt: string; date: string }
)
export type WardrobeSource = { id: string; title: string; url: string; publishedAt: string | null; sourceName: string; read?: boolean; excerpt?: string }
export type WardrobeTrace = { tool: string; status: 'ok' | 'error'; summary: string; durationMs: number }
export type WardrobeAgentReply = {
  text: string; status: 'completed' | 'limited' | 'unavailable'; provider: string | null
  actions: WardrobeAction[]; sources: WardrobeSource[]; trace: WardrobeTrace[]; warnings: string[]
  metrics?: { modelCalls: number; toolCalls: number; durationMs: number; promptTokens: number; completionTokens: number; costUsd: number | null; models: string[] }
}
export type WardrobeChatMessage = {
  id: string; role: 'user' | 'assistant'; text: string; createdAt: string
  reply?: WardrobeAgentReply
  results?: Record<string, { status: 'applied' | 'dismissed'; message: string }>
  attachments?: { id: string; name: string; garmentId?: string }[]
  receipts?: WardrobeToolReceipt[]
}
export type WardrobePhotoContext = { status: 'saved' | 'discussed' | 'unclear' | 'failed'; description: string; garmentId?: string }
export type WardrobePhotoInspection = {
  id: string; status: 'recognized' | 'needs_clarification' | 'not_clothing'; draft: WardrobeGarmentDraft | null
  description: string; uncertainties: string[]; provider: string; model?: string
}
export type WardrobeChatRequest = {
  message: string; history: { role: 'user' | 'assistant'; content: string }[]
  snapshot: WardrobeSnapshot; today: string; allowTrends: boolean; trendTopic: string
  photoContext?: WardrobePhotoContext[]
  attachments?: { id: string; name: string; processing: 'original' | 'background-removed' }[]
  currentImageIds?: string[]
  turnId?: string
}
export type WardrobeAgentCapabilities = { configured: boolean; provider: string | null; tools: string[]; vision?: { configured: boolean; provider: string | null } }
export type WardrobeAgentProgress = { phase: 'thinking' | 'tool' | 'queued' | 'running'; tool?: string; status: 'started' | 'ok' | 'error' }
export type WardrobeAgentEvent = { type: 'progress'; progress: WardrobeAgentProgress } | { type: 'result'; reply: WardrobeAgentReply } | { type: 'error'; error: string } | { type: 'tool_request'; token: string; call: WardrobeClientCall }
