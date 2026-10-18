import type { WardrobeClientArguments, WardrobeClientCall, WardrobeClientResult } from '../../../../shared/wardrobe-tools'
import type { AgentGarment, WardrobeAction, WardrobeGarmentDraft } from '../../../../shared/wardrobe-agent'
import type { Garment, GarmentPhoto, WardrobeRepository } from './types'
import type { ChatAsset, ChatAssets } from './chatAssets'
import { inspectChatPhoto, PhotoInspectionError } from './chatPhotos'
import { removePhotoBackground } from './photoProcessor'

const metadata = ({ id, name, category, color, season, brand, notes, updatedAt }: Garment): AgentGarment => ({ id, name, category, color, season, brand, notes, updatedAt })
const fields = ['name', 'category', 'color', 'season', 'brand', 'notes'] as const
function changes(value: unknown): Partial<WardrobeGarmentDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Нужны поля карточки вещи.')
  if (Object.keys(value).some(key => !fields.includes(key as typeof fields[number]))) throw new Error('Неизвестное поле карточки.')
  return Object.fromEntries(fields.filter(key => key in value).map(key => [key, (value as Record<string, unknown>)[key]]))
}
export function createChatToolExecutor(options: {
  repository: WardrobeRepository; assets: ChatAssets; allowedImageIds: string[]
  apply: (action: WardrobeAction, photo?: GarmentPhoto) => Promise<string>
  inspect?: typeof inspectChatPhoto; removeBackground?: typeof removePhotoBackground
  onResult?: (result: WardrobeClientResult) => void
}) {
  const allowed = new Set(options.allowedImageIds)
  const completed = new Map<string, WardrobeClientResult>()
  const inspections = new Map<string, Awaited<ReturnType<typeof inspectChatPhoto>>>()
  async function source(id: unknown): Promise<ChatAsset> {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Укажите реальный imageId из вложений или поиска гардероба.')
    if (id.startsWith('garment:')) {
      const garment = (await options.repository.list()).find(item => item.id === id.slice(8))
      if (!garment) throw new Error('Вещь удалена или не найдена.')
      return { id, name: garment.name, photo: garment.photo, createdAt: garment.createdAt }
    }
    if (!allowed.has(id)) throw new Error('Изображение не относится к этому диалогу.')
    const asset = await options.assets.get(id)
    if (!asset) throw new Error('Вложение недоступно. Прикрепите фотографию ещё раз.')
    return asset
  }
  async function inspect(asset: ChatAsset, focus: string, signal: AbortSignal) {
    const key = `${asset.id}:${focus}`
    const previous = inspections.get(key) ?? asset.inspections?.find(item => item.focus === focus)?.result ?? (!focus ? asset.inspections?.at(-1)?.result : undefined)
    if (previous) return previous
    const result = await (options.inspect ?? inspectChatPhoto)({ ...asset, id: crypto.randomUUID() }, focus, signal)
    inspections.set(key, result)
    if (result.status === 'recognized' && !asset.id.startsWith('garment:')) {
      asset.inspections = [...(asset.inspections ?? []).filter(item => item.focus !== focus), { focus, result }].slice(-3)
      await options.assets.put(asset)
    }
    return result
  }
  return async (call: WardrobeClientCall, signal: AbortSignal): Promise<WardrobeClientResult> => {
    if (completed.has(call.id)) return completed.get(call.id)!
    signal.throwIfAborted()
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(call.id)) throw new Error('Некорректный ID действия.')
    const args = call.arguments as WardrobeClientArguments
    if (!args || typeof args !== 'object') throw new Error('Некорректные параметры инструмента.')
    const focus = typeof args.focus === 'string' ? args.focus.slice(0, 500) : ''
    let result: WardrobeClientResult
    if (call.name === 'wardrobe_inspect_image' || call.name === 'wardrobe_add_from_image') {
      const asset = await source(args.imageId)
      const actionId = `image-${asset.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      if (call.name === 'wardrobe_add_from_image') {
        const existing = (await options.repository.list()).find(item => item.id === `stylist-${actionId}`)
        if (existing) {
          const result: WardrobeClientResult = { ok: true, garment: metadata(existing), receipt: { id: call.id, tool: call.name, summary: `Вещь «${existing.name}» уже в гардеробе. Повторная запись не создана.`, garmentId: existing.id, imageId: asset.id } }
          completed.set(call.id, result)
          options.onResult?.(result)
          return result
        }
      }
      let inspected: Awaited<ReturnType<typeof inspect>>
      try { inspected = await inspect(asset, focus, signal) }
      catch (cause) {
        if (signal.aborted) throw cause
        if (!(cause instanceof PhotoInspectionError)) throw cause
        return { ok: false, error: cause.message, code: cause.code, retryable: cause.retryable, image: { id: asset.id, name: asset.name.slice(0, 120), processing: asset.photo.processing } }
      }
      signal.throwIfAborted()
      const inspection = { status: inspected.status, draft: inspected.draft, description: inspected.description, uncertainties: inspected.uncertainties }
      result = { ok: true, inspection }
      if (call.name === 'wardrobe_add_from_image') {
        if (inspection.status !== 'recognized' || !inspection.draft) return { ok: false, inspection, error: 'Вещь не добавлена. ' + inspection.description }
        const draft = { ...inspection.draft, ...changes(args.overrides ?? {}) }
        const action: WardrobeAction = { id: actionId, kind: 'garment', draft, reason: inspection.description }
        signal.throwIfAborted()
        const summary = await options.apply(action, asset.photo)
        const saved = (await options.repository.list()).find(item => item.id === `stylist-${actionId}`)
        if (!saved) throw new Error('Вещь после добавления была удалена. Повтор не восстанавливает её.')
        result = { ok: true, inspection, garment: metadata(saved), receipt: { id: call.id, tool: call.name, summary, garmentId: saved.id, imageId: asset.id } }
      }
    } else if (call.name === 'wardrobe_remove_background') {
      const asset = await source(args.imageId)
      const id = asset.photo.processing === 'background-removed' ? asset.id : `cutout-${call.id}`
      const previous = asset.photo.processing === 'background-removed' ? asset : await options.assets.get(id)
      const cleaned = previous ?? { id, name: asset.name, createdAt: new Date().toISOString(), photo: await (options.removeBackground ?? removePhotoBackground)(asset.photo.original, signal), inspections: asset.inspections }
      signal.throwIfAborted()
      if (!previous) await options.assets.put(cleaned)
      allowed.add(id)
      result = { ok: true, image: { id, name: asset.name, processing: 'background-removed' }, receipt: { id: call.id, tool: call.name, summary: 'Фон удалён. Исходная фотография сохранена.', imageId: id } }
    } else if (call.name === 'wardrobe_update_garment' || call.name === 'wardrobe_replace_photo') {
      const garment = (await options.repository.list()).find(item => item.id === args.garmentId)
      if (!garment) throw new Error('Вещь не найдена. Сначала найди её в гардеробе.')
      const photo = call.name === 'wardrobe_replace_photo' ? (await source(args.imageId)).photo : undefined
      const draft = { ...metadata(garment), ...(photo ? {} : changes(args.changes)) }
      const action: WardrobeAction = { id: call.id, kind: 'update', garmentId: garment.id, expectedUpdatedAt: String(args.expectedUpdatedAt), draft, reason: 'Изменение по запросу в чате', ...(photo ? { replacePhoto: true } : {}) }
      signal.throwIfAborted()
      const summary = await options.apply(action, photo)
      const saved = (await options.repository.list()).find(item => item.id === garment.id)
      if (!saved) throw new Error('Вещь удалена после изменения.')
      result = { ok: true, garment: metadata(saved), receipt: { id: call.id, tool: call.name, summary: photo ? `Фотография «${saved.name}» обновлена.` : summary, garmentId: saved.id } }
    } else throw new Error('Неизвестный инструмент гардероба.')
    completed.set(call.id, result)
    options.onResult?.(result)
    return result
  }
}
