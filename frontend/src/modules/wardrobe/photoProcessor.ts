import type { GarmentPhoto, PhotoProcessor } from './types'

export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp'
const allowedTypes = new Set(PHOTO_ACCEPT.split(','))
const maxBytes = 15 * 1024 * 1024

/** Validate locally before storage or an explicit processing request. */
export const originalPhotoProcessor: PhotoProcessor = {
  async process(file) {
    if (!allowedTypes.has(file.type)) {
      throw new Error('Выберите фотографию в формате JPG, PNG или WebP.')
    }
    if (file.size > maxBytes) {
      throw new Error('Фото слишком большое. Максимальный размер — 15 МБ.')
    }
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new Error('Не удалось прочитать фото. Попробуйте другое изображение.')
    }
    const pixels = bitmap.width * bitmap.height
    bitmap.close()
    if (pixels > 40_000_000) {
      throw new Error('Уменьшите фотографию до 40 мегапикселей или меньше.')
    }
    return { original: file, display: file, processing: 'original' }
  },
}

type PhotoJob = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; error?: string }
export type PhotoProgress = 'preparing' | 'queued' | 'running'

async function prepareUpload(original: Blob) {
  const bitmap = await createImageBitmap(original)
  try {
    const ratio = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Браузер не смог подготовить фотографию.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось подготовить фото.')), 'image/png'))
  } finally { bitmap.close() }
}

async function checkResponse(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || 'Не удалось удалить фон. Оригинал сохранён.')
  }
  return response
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const cancel = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, 2500)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function removePhotoBackground(original: Blob, signal?: AbortSignal, onProgress?: (progress: PhotoProgress) => void): Promise<GarmentPhoto> {
  const timeout = AbortSignal.timeout(10 * 60_000)
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let jobId: string | undefined
  let completed = false
  try {
    onProgress?.('preparing')
    const upload = await prepareUpload(original)
    activeSignal.throwIfAborted()
    // Receive the id even if cancelled during submission, so we can cancel the remote job.
    const created = await checkResponse(await fetch('/api/wardrobe/photos/remove-background', {
      method: 'POST', headers: { 'Content-Type': upload.type }, body: upload, signal: AbortSignal.timeout(35_000),
    }))
    let job = await created.json() as PhotoJob
    if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)) throw new Error('Не удалось создать задачу обработки.')
    jobId = job.id
    while (true) {
      activeSignal.throwIfAborted()
      if (job.status === 'succeeded') break
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error || 'Обработка не завершена. Оригинал сохранён.')
      if (job.status !== 'queued' && job.status !== 'running') throw new Error('Неизвестное состояние обработки фото.')
      onProgress?.(job.status)
      await pause(activeSignal)
      job = await (await checkResponse(await fetch(`/api/wardrobe/photos/jobs/${jobId}`, { signal: activeSignal }))).json() as PhotoJob
    }
    const response = await checkResponse(await fetch(`/api/wardrobe/photos/jobs/${jobId}/result`, { signal: activeSignal }))
    const display = await response.blob()
    if (display.type !== 'image/png') throw new Error('Обработчик вернул некорректный формат изображения.')
    let bitmap: ImageBitmap
    try { bitmap = await createImageBitmap(display) } catch {
      throw new Error('Не удалось прочитать обработанное фото. Оригинал сохранён.')
    }
    bitmap.close()
    completed = true
    return { original, display, processing: 'background-removed' }
  } catch (cause) {
    if (signal?.aborted) throw cause
    if (timeout.aborted) throw new Error('Обработка заняла слишком много времени. Оригинал сохранён; попробуйте позже.')
    if (cause instanceof TypeError) throw new Error('Не удалось связаться с обработчиком фото. Оригинал сохранён.')
    throw cause
  } finally {
    if (jobId && !completed) {
      // Cancellation is best effort; the server checks ownership before calling Runpod.
      void fetch(`/api/wardrobe/photos/jobs/${jobId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(35_000) }).catch(() => undefined)
    }
  }
}
