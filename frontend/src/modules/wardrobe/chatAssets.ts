import type { GarmentPhoto } from './types'
import type { WardrobePhotoInspection } from '../../../../shared/wardrobe-agent'

export type ChatAsset = { id: string; name: string; photo: GarmentPhoto; createdAt: string; inspections?: { focus: string; result: WardrobePhotoInspection }[] }
/** Photo bytes stay in this browser, including attachments discussed without adding a garment. */
export function createChatAssets(namespace: string) {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${namespace}:stylist-images-v1`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode)
      const request = operation(tx.objectStore('images'))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить вложение.'))
    })
  }
  return {
    get: (id: string) => transaction<ChatAsset | undefined>('readonly', store => store.get(id)),
    async put(asset: ChatAsset) { await transaction('readwrite', store => store.put(asset)) },
    async close() { (await database).close() },
  }
}
export type ChatAssets = ReturnType<typeof createChatAssets>
