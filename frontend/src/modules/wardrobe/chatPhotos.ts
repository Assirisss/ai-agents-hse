import type { WardrobePhotoInspection } from '../../../../shared/wardrobe-agent'
import type { GarmentPhoto } from './types'

export type PendingChatPhoto = { id: string; name: string; photo: GarmentPhoto }
export class PhotoInspectionError extends Error {
  readonly retryable: boolean
  readonly code: string
  constructor(message: string, retryable: boolean, code = 'vision_unavailable') { super(message); this.retryable = retryable; this.code = code }
}

async function imageForVision(original: Blob): Promise<string> {
  const bitmap = await createImageBitmap(original)
  let blob: Blob
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не удалось подготовить фото для распознавания.')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось подготовить фото.')), 'image/jpeg', .85))
  } finally { bitmap.close() }
  if (blob.size > 2 * 1024 * 1024) throw new Error('Фото слишком большое для распознавания. Уменьшите его и попробуйте снова.')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать фото.'))
    reader.readAsDataURL(blob)
  })
}

export async function inspectChatPhoto(item: PendingChatPhoto, message: string, signal: AbortSignal): Promise<WardrobePhotoInspection> {
  const image = await imageForVision(item.photo.original)
  signal.throwIfAborted()
  try {
    const response = await fetch('/api/wardrobe/agent/photos/inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(100000)]),
      body: JSON.stringify({ id: item.id, message, image }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body) throw new PhotoInspectionError(body?.error || 'Не удалось распознать фото. Вещь не добавлена.', body?.retryable ?? (response.status === 429 || response.status >= 500), body?.code)
    return body as WardrobePhotoInspection
  } catch (cause) {
    if (signal.aborted) throw cause
    if (cause instanceof PhotoInspectionError) throw cause
    throw new PhotoInspectionError('Не удалось связаться с распознаванием. Фотография сохранена в чате; можно повторить добавление позже.', true)
  }
}
