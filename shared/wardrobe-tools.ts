import type { AgentGarment, WardrobeGarmentDraft, WardrobePhotoInspection } from './wardrobe-agent'
export type WardrobeClientToolName = 'wardrobe_inspect_image' | 'wardrobe_remove_background' | 'wardrobe_add_from_image' | 'wardrobe_update_garment' | 'wardrobe_replace_photo'
export type WardrobeClientCall = { id: string; name: WardrobeClientToolName; arguments: unknown }
export type WardrobeToolReceipt = { id: string; tool: string; summary: string; garmentId?: string; imageId?: string }
export type WardrobeClientResult = {
  ok: boolean; error?: string
  code?: string; retryable?: boolean
  image?: { id: string; name: string; processing: 'original' | 'background-removed' }
  inspection?: Pick<WardrobePhotoInspection, 'status' | 'draft' | 'description' | 'uncertainties'>
  garment?: AgentGarment; receipt?: WardrobeToolReceipt
}
export type WardrobeClientArguments = { imageId?: string; focus?: string; overrides?: Partial<WardrobeGarmentDraft>; garmentId?: string; expectedUpdatedAt?: string; changes?: Partial<WardrobeGarmentDraft> }
