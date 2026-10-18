import type { Garment, Outfit, WardrobeRepository, WearEvent, WishlistItem } from './types'
import { arrangeOutfitLayers, combinationKey, validateOutfit, validateWearDate } from './outfitDomain'
import { validateGarment, validateWishlist } from './wishlistDomain'

const storeName = 'garments'

/** A separate database name allows browser checks without touching user records. */
export function createBrowserWardrobeRepository(databaseName: string): WardrobeRepository {
  let connection: Promise<IDBDatabase> | undefined

  function openDatabase(): Promise<IDBDatabase> {
    if (!connection) {
      connection = new Promise<IDBDatabase>((resolve, reject) => {
        let abandoned = false
        const request = indexedDB.open(databaseName, 4)
        request.onupgradeneeded = () => {
          for (const name of [storeName, 'outfits', 'wearEvents', 'wishlist', 'agentActions']) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' })
          }
        }
        request.onsuccess = () => {
          const database = request.result
          if (abandoned) { database.close(); return }
          database.onversionchange = () => { database.close(); connection = undefined }
          resolve(database)
        }
        request.onerror = () => reject(request.error)
        request.onblocked = () => {
          abandoned = true
          reject(new Error('Закройте другие вкладки приложения и попробуйте снова.'))
        }
      }).catch(cause => { connection = undefined; throw cause })
    }
    return connection
  }

  async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>, name = storeName): Promise<T> {
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(name, mode)
      const request = operation(transaction.objectStore(name))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('Не удалось сохранить изменения.'))
      transaction.onerror = () => reject(transaction.error ?? request.error)
    })
  }

  /** Keep reference validation, duplicate checks and writes in one atomic transaction. */
  async function withOutfitData<T>(action: (transaction: IDBTransaction, done: (result: T) => void, fail: (error: Error) => void) => void, stores = [storeName, 'outfits', 'wearEvents']): Promise<T> {
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(stores, 'readwrite')
      let result: T
      let failure: Error | undefined
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Не удалось сохранить изменения.'))
      transaction.onerror = () => { /* onabort reports the final failure. */ }
      const fail = (error: Error) => { failure = error; transaction.abort() }
      try { action(transaction, value => { result = value }, fail) } catch (cause) { fail(cause instanceof Error ? cause : new Error('Ошибка сохранения.')) }
    })
  }

  return {
    namespace: databaseName,
    async list() {
      const garments = await transact<Garment[]>('readonly', store => store.getAll())
      return garments.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    async save(garment) {
      try {
        await transact('readwrite', store => store.put(validateGarment(garment)))
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'QuotaExceededError') {
          throw new Error('В браузере закончилось место. Выберите фото меньшего размера или освободите место.')
        }
        throw cause
      }
    },
    async remove(id) {
      await transact('readwrite', store => store.delete(id))
    },
    async listOutfits() {
      const items = await transact<Outfit[]>('readonly', store => store.getAll(), 'outfits')
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    async saveOutfit(outfit) {
      const draft = validateOutfit(outfit)
      await withOutfitData<void>((transaction, done, fail) => {
        const request = transaction.objectStore(storeName).getAll()
        request.onsuccess = () => {
          const garments = new Set((request.result as Garment[]).map(item => item.id))
          if (draft.layers.some(layer => !garments.has(layer.garmentId))) {
            fail(new Error('Одна из вещей удалена из гардероба. Уберите её с доски перед сохранением.'))
            return
          }
          transaction.objectStore('outfits').put({ ...outfit, ...draft })
          done(undefined)
        }
      })
    },
    async removeOutfit(id) {
      await transact('readwrite', store => store.delete(id), 'outfits')
    },
    async listWearEvents() {
      const items = await transact<WearEvent[]>('readonly', store => store.getAll(), 'wearEvents')
      return items.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    },
    async recordWear(outfitId, date) {
      validateWearDate(date)
      return withOutfitData<WearEvent>((transaction, done, fail) => {
        const outfitRequest = transaction.objectStore('outfits').get(outfitId)
        outfitRequest.onsuccess = () => {
          const outfit = outfitRequest.result as Outfit | undefined
          if (!outfit) { fail(new Error('Образ больше не существует.')); return }
          const key = combinationKey(outfit.layers)
          const id = `${date}:${key}`
          const existing = transaction.objectStore('wearEvents').get(id)
          existing.onsuccess = () => {
            if (existing.result) { done(existing.result as WearEvent); return }
            const garmentsRequest = transaction.objectStore(storeName).getAll()
            garmentsRequest.onsuccess = () => {
              const catalog = new Map((garmentsRequest.result as Garment[]).map(item => [item.id, item]))
              const garments: WearEvent['garments'] = []
              for (const layer of outfit.layers) {
                const garment = catalog.get(layer.garmentId)
                if (!garment) { fail(new Error('В образе есть удалённая вещь. Сначала измените состав образа.')); return }
                garments.push({ id: garment.id, name: garment.name })
              }
              const event: WearEvent = { id, date, outfitId, outfitName: outfit.name, combinationKey: key, garments, createdAt: new Date().toISOString() }
              transaction.objectStore('wearEvents').add(event)
              done(event)
            }
          }
        }
      })
    },
    async removeWearEvent(id) {
      await transact('readwrite', store => store.delete(id), 'wearEvents')
    },
    async listWishlist() {
      const items = await transact<WishlistItem[]>('readonly', store => store.getAll(), 'wishlist')
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    async saveWishlistItem(item) {
      const draft = validateWishlist(item)
      return withOutfitData<WishlistItem>((transaction, done) => {
        const store = transaction.objectStore('wishlist')
        const request = store.get(item.id)
        request.onsuccess = () => {
          const previous = request.result as WishlistItem | undefined
          const saved: WishlistItem = { ...item, ...draft, status: previous?.status ?? 'planned', garmentId: previous?.garmentId }
          store.put(saved)
          done(saved)
        }
      }, ['wishlist'])
    },
    async removeWishlistItem(id) {
      await transact('readwrite', store => store.delete(id), 'wishlist')
    },
    async purchaseWishlistItem(id, garment) {
      const validated = validateGarment(garment)
      return withOutfitData<{ item: WishlistItem; garment: Garment }>((transaction, done, fail) => {
        const wishlist = transaction.objectStore('wishlist')
        const garments = transaction.objectStore(storeName)
        const request = wishlist.get(id)
        request.onsuccess = () => {
          const item = request.result as WishlistItem | undefined
          if (!item) { fail(new Error('Эта покупка уже удалена из списка.')); return }
          if (item.status === 'purchased') {
            const linked = garments.get(item.garmentId ?? '')
            linked.onsuccess = () => {
              if (!linked.result) { fail(new Error('Покупка уже добавлялась в гардероб, но вещь была удалена.')); return }
              done({ item, garment: linked.result as Garment })
            }
            return
          }
          const collision = garments.get(validated.id)
          collision.onsuccess = () => {
            if (collision.result) { fail(new Error('Вещь с таким идентификатором уже существует.')); return }
            const purchased: WishlistItem = { ...item, status: 'purchased', garmentId: validated.id, updatedAt: new Date().toISOString() }
            garments.add(validated)
            wishlist.put(purchased)
            done({ item: purchased, garment: validated })
          }
        }
      }, [storeName, 'wishlist'])
    },
    async applyAgentAction(action, photo) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(action.id)) throw new Error('Недопустимый идентификатор действия.')
      return withOutfitData<string>((transaction, done, fail) => {
        const receipts = transaction.objectStore('agentActions')
        const receipt = receipts.get(action.id)
        receipt.onsuccess = () => {
          if (receipt.result) { done('Это действие уже выполнено. Повторная запись не создана.'); return }
          const garmentsRequest = transaction.objectStore(storeName).getAll()
          garmentsRequest.onsuccess = () => {
            // Every validation and write below belongs to the same IndexedDB transaction.
            const guard = (operation: () => void) => { try { operation() } catch (cause) { fail(cause instanceof Error ? cause : new Error('Не удалось применить предложение.')) } }
            guard(() => {
              const garments = garmentsRequest.result as Garment[]
              const now = new Date().toISOString()
              const id = `stylist-${action.id}`
              const saved = (message: string) => { receipts.add({ id: action.id, kind: action.kind, appliedAt: now }); done(message) }
              if (action.kind === 'outfit') {
                if (action.garmentIds.length < 1 || action.garmentIds.length > 20 || new Set(action.garmentIds).size !== action.garmentIds.length || action.garmentIds.some(id => !garments.some(item => item.id === id))) throw new Error('Состав изменился или недопустим: проверьте вещи и попросите стилиста обновить образ.')
                const draft = validateOutfit({ name: action.name, notes: action.notes, layers: arrangeOutfitLayers(action.garmentIds, garments) })
                transaction.objectStore('outfits').add({ ...draft, id, createdAt: now, updatedAt: now })
                saved(`Образ «${draft.name}» сохранён.`)
              } else if (action.kind === 'purchase') {
                const draft = validateWishlist(action.draft)
                transaction.objectStore('wishlist').add({ ...draft, id, status: 'planned', createdAt: now, updatedAt: now })
                saved(`«${draft.name}» добавлено в желания.`)
              } else if (action.kind === 'garment') {
                if (!photo) throw new Error('Сначала добавьте фотографию вещи.')
                const garment = validateGarment({ ...action.draft, id, photo, createdAt: now, updatedAt: now })
                transaction.objectStore(storeName).add(garment)
                saved(`Вещь «${garment.name}» добавлена.`)
              } else if (action.kind === 'update') {
                const previous = garments.find(item => item.id === action.garmentId)
                if (!previous || previous.updatedAt !== action.expectedUpdatedAt) throw new Error('Вещь изменилась или удалена после ответа стилиста. Попросите обновить предложение.')
                if (action.replacePhoto && !photo) throw new Error('Не передана новая фотография.')
                const garment = validateGarment({ ...previous, ...action.draft, ...(action.replacePhoto ? { photo } : {}), updatedAt: now })
                transaction.objectStore(storeName).put(garment)
                saved(`Данные вещи «${garment.name}» обновлены.`)
              } else if (action.kind === 'wear') {
                validateWearDate(action.date)
                const outfitRequest = transaction.objectStore('outfits').get(action.outfitId)
                outfitRequest.onsuccess = () => guard(() => {
                  const outfit = outfitRequest.result as Outfit | undefined
                  if (!outfit || outfit.updatedAt !== action.expectedUpdatedAt) throw new Error('Образ изменился или удалён. Попросите стилиста обновить отметку.')
                  const worn = outfit.layers.map(layer => {
                    const garment = garments.find(item => item.id === layer.garmentId)
                    if (!garment) throw new Error('В образе есть удалённая вещь.')
                    return { id: garment.id, name: garment.name }
                  })
                  const key = combinationKey(outfit.layers)
                  const eventId = `${action.date}:${key}`
                  const existing = transaction.objectStore('wearEvents').get(eventId)
                  existing.onsuccess = () => guard(() => {
                    if (!existing.result) transaction.objectStore('wearEvents').add({ id: eventId, date: action.date, outfitId: outfit.id, outfitName: outfit.name, combinationKey: key, garments: worn, createdAt: now })
                    saved(existing.result ? 'Это сочетание уже отмечено на выбранную дату.' : `Выход ${action.date} отмечен.`)
                  })
                })
              } else throw new Error('Неизвестное действие стилиста.')
            })
          }
        }
      }, [storeName, 'outfits', 'wearEvents', 'wishlist', 'agentActions'])
    },
  }
}

/** Photos are Blobs in IndexedDB, never base64 in localStorage. */
export const browserWardrobeRepository = createBrowserWardrobeRepository('graphite-wardrobe')
