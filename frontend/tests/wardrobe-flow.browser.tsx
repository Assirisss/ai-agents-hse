import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import OutfitEditor from '../src/modules/wardrobe/OutfitEditor'
import CollectionView from '../src/modules/wardrobe/CollectionView'
import WardrobePage from '../src/modules/wardrobe/WardrobePage'
import { createBrowserWardrobeRepository } from '../src/modules/wardrobe/repository'
import type { Garment, OutfitDraft, OutfitLayer } from '../src/modules/wardrobe/types'
import type { BrowserCheck } from './outfits.browser'

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
async function eventually(condition: () => boolean) {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Интерфейс не обновился вовремя')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function runWardrobeFlowChecks(check: BrowserCheck, garment: Garment) {
  await check('Модель вызывает добавление по запросу: фото → инструмент → сохранение → ответ, без переключателя', async () => {
    const repository = createBrowserWardrobeRepository(`wardrobe-chat-photo-${crypto.randomUUID()}`)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const actualFetch = window.fetch
    let recognized = false
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/capabilities')) return Response.json({ configured: true, provider: 'test', tools: [], vision: { configured: true, provider: 'test' } })
      if (String(url).endsWith('/chat/stream')) {
        const body = JSON.parse(String(init?.body))
        assert(body.attachments?.length === 1 && !body.photoContext, 'Фото не должно распознаваться до решения модели')
        assert(!recognized, 'Вызов vision до tool call')
        return new Response(new ReadableStream({ start(controller) {
          stream = controller
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'tool_request', token: 'test-token', call: { id: 'browser-add-photo', name: 'wardrobe_add_from_image', arguments: { imageId: body.attachments[0].id, focus: '', overrides: {} } } }) + '\n'))
        } }))
      }
      if (String(url).includes('/tool-results/')) {
        const body = JSON.parse(String(init?.body))
        assert(body.result.ok && body.result.garment, 'Модели не вернулся результат фактического сохранения')
        stream!.enqueue(encoder.encode(JSON.stringify({ type: 'result', reply: { text: 'Футболка добавлена.', status: 'completed', provider: 'test', actions: [], sources: [], trace: [], warnings: [] } }) + '\n'))
        stream!.close()
        return Response.json({ accepted: true })
      }
      if (String(url).endsWith('/photos/inspect')) {
        const body = JSON.parse(String(init?.body))
        assert(body.image.startsWith('data:image/jpeg;base64,'), 'В распознавание должна уйти уменьшенная JPEG-копия')
        recognized = true
        return Response.json({ id: body.id, status: 'recognized', draft: { name: 'Футболка с фото', category: 'tops', color: 'white', season: 'all', brand: '', notes: '' }, description: 'Белая футболка.', uncertainties: [], provider: 'test' })
      }
      throw new Error(`Неожиданный запрос: ${url}`)
    }
    try {
      flushSync(() => root.render(<WardrobePage repository={repository} />))
      await eventually(() => !!host.querySelector('#wd-panel-collection'))
      flushSync(() => host.querySelector<HTMLButtonElement>('#wd-tab-stylist')!.click())
      await eventually(() => !!host.querySelector('.wd-stylist-attach:not(:disabled)'))
      const file = new File([garment.photo.original], 'shirt.png', { type: garment.photo.original.type })
      const transfer = new DataTransfer(); transfer.items.add(file)
      const input = host.querySelector<HTMLInputElement>('.wd-stylist-composer input[type="file"]')!
      flushSync(() => { input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })) })
      await eventually(() => !!host.querySelector('.wd-stylist-photo-tray'))
      assert(!host.querySelector('.wd-stylist-photo-tray input[type="checkbox"]'), 'Старый переключатель остался в интерфейсе')
      const composer = host.querySelector<HTMLTextAreaElement>('#wd-stylist-message')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'Добавь эту вещь в гардероб')
      flushSync(() => composer.dispatchEvent(new Event('input', { bubbles: true })))
      flushSync(() => host.querySelector<HTMLFormElement>('.wd-stylist-composer')!.requestSubmit())
      await eventually(() => !!host.querySelector('.wd-chat-attachment small'))
      assert(recognized, 'Распознавание не вызвано')
      assert(!host.querySelector('dialog[open]'), 'Автоматическое добавление не должно требовать заполнения второй формы')
      const saved = (await repository.list())[0]
      assert(saved?.name === 'Футболка с фото', 'Распознанная вещь не сохранена')
      assert(saved.photo.original.size === file.size, 'Исходное фото потеряно')
      assert(!!host.querySelector('.wd-chat-attachment small'), 'В чате нет ссылки на сохранённую вещь')
    } finally { flushSync(() => root.unmount()); host.remove(); window.fetch = actualFetch; localStorage.removeItem(`${repository.namespace}:stylist-chat-v1`); indexedDB.deleteDatabase(repository.namespace) }
  })

  await check('Чат стилиста: снимок без фото → карточка образа → применение в каталоге', async () => {
    const repository = createBrowserWardrobeRepository(`wardrobe-chat-flow-${crypto.randomUUID()}`)
    await repository.save(garment)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const realFetch = window.fetch
    let sentWithoutPhoto = false
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/capabilities')) return Response.json({ configured: true, provider: 'test', tools: [] })
      if (String(url).endsWith('/chat/stream')) {
        const body = JSON.parse(String(init?.body))
        sentWithoutPhoto = body.snapshot.garments[0].id === garment.id && !('photo' in body.snapshot.garments[0])
        return new Response(JSON.stringify({ type: 'result', reply: { text: 'Подготовил **образ**.', status: 'completed', provider: 'test', actions: [{ id: crypto.randomUUID(), kind: 'outfit', name: 'Образ из чата', notes: '', garmentIds: [garment.id], reason: 'Проверка реального применения' }], trace: [], sources: [], warnings: [] } }) + '\n')
      }
      throw new Error(`Неожиданный запрос: ${url}`)
    }
    try {
      flushSync(() => root.render(<WardrobePage repository={repository} />))
      await eventually(() => !!host.querySelector('#wd-panel-collection'))
      flushSync(() => host.querySelector<HTMLButtonElement>('#wd-tab-stylist')!.click())
      await eventually(() => !!host.querySelector('.wd-stylist-starters button:not(:disabled)'))
      const input = host.querySelector<HTMLTextAreaElement>('#wd-stylist-message')!
      flushSync(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Собери образ'); input.dispatchEvent(new Event('input', { bubbles: true })) })
      flushSync(() => host.querySelector<HTMLFormElement>('.wd-stylist-composer')!.requestSubmit())
      await eventually(() => !!host.querySelector('.wd-stylist-action'))
      assert(sentWithoutPhoto, 'В запросе не должно быть фотографии')
      assert((await repository.listOutfits()).length === 0, 'Предложение не должно само сохраняться')
      assert(host.querySelector('.wd-chat-markdown strong')?.textContent === 'образ', 'Markdown не оформлен')
      flushSync(() => host.querySelector<HTMLButtonElement>('.wd-stylist-action .wd-primary')!.click())
      await eventually(() => !!host.querySelector('.wd-stylist-action-result'))
      assert((await repository.listOutfits()).length === 1, 'Карточка не применилась к платформе')
    } finally { flushSync(() => root.unmount()); host.remove(); window.fetch = realFetch; localStorage.removeItem(`${repository.namespace}:stylist-chat-v1`); indexedDB.deleteDatabase(repository.namespace) }
  })

  await check('Выбор вещей в коллекции передаёт состав нового образа', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let selected: string[] = []
    try {
      flushSync(() => root.render(<CollectionView garments={[garment]} events={[]} onAdd={() => undefined} onOpen={() => { throw new Error('Вместо выбора открылась карточка') }} onCreateOutfit={ids => { selected = ids }} />))
      const select = [...host.querySelectorAll('button')].find(button => button.textContent === 'Выбрать вещи')!
      flushSync(() => select.click())
      flushSync(() => host.querySelector<HTMLButtonElement>('.wd-garment')!.click())
      assert(host.querySelector('.wd-garment')?.getAttribute('aria-pressed') === 'true', 'Вещь не выделена')
      flushSync(() => host.querySelector<HTMLButtonElement>('.wd-selection-bar .wd-primary')!.click())
      assert(selected.length === 1 && selected[0] === garment.id, 'Выбранный состав потерян')
    } finally { flushSync(() => root.unmount()); host.remove() }
  })

  await check('Отмена откатывает целый жест перетаскивания; повтор восстанавливает его', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let saved: OutfitDraft | undefined
    const layers: OutfitLayer[] = [{ garmentId: garment.id, x: 5, y: 8, size: 40 }]
    try {
      flushSync(() => root.render(<OutfitEditor outfit={null} initialDraft={{ name: 'Тест истории действий', notes: '', layers }} garments={[garment]} onSave={async draft => { saved = draft }} onCancel={() => undefined} onRemove={undefined} />))
      const board = host.querySelector<HTMLElement>('.wd-board')!
      board.style.width = '400px'; board.style.height = '500px'
      const button = host.querySelector<HTMLButtonElement>('.wd-board-layer')!
      button.setPointerCapture = () => undefined
      const pointer = { pointerId: 1, isPrimary: true, button: 0, bubbles: true }
      flushSync(() => button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 10, clientY: 10 })))
      flushSync(() => button.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 50, clientY: 60 })))
      flushSync(() => button.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 90, clientY: 110 })))
      flushSync(() => button.dispatchEvent(new PointerEvent('pointerup', pointer)))
      flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение доски"]')!.click())
      assert(button.style.left === '5%' && button.style.top === '8%', 'Отмена вернула только часть жеста')
      flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Повторить изменение доски"]')!.click())
      flushSync(() => host.querySelector('form')!.requestSubmit())
      await Promise.resolve()
      assert(saved?.layers[0].x === 25 && saved.layers[0].y === 28, 'Повтор не восстановил координаты')
    } finally { flushSync(() => root.unmount()); host.remove() }
  })

  await check('Полный интерфейс: покупка → заполненная карточка → вещь в гардеробе', async () => {
    const databaseName = `wardrobe-flow-${crypto.randomUUID()}`
    const repository = createBrowserWardrobeRepository(databaseName)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await repository.saveWishlistItem({ id: 'flow-purchase', name: 'Рубашка из магазина', category: 'tops', priceMinor: 350000, currency: 'RUB', priority: 'normal', url: '', notes: 'Тест покупки', photo: garment.photo, status: 'planned', createdAt: garment.createdAt, updatedAt: garment.updatedAt })
      flushSync(() => root.render(<WardrobePage repository={repository} />))
      await eventually(() => !!host.querySelector('#wd-panel-collection'))
      flushSync(() => host.querySelector<HTMLButtonElement>('#wd-tab-wishlist')!.click())
      await eventually(() => !!host.querySelector('.wd-wishlist-card'))
      flushSync(() => host.querySelector<HTMLButtonElement>('.wd-wishlist-card-body > .wd-secondary')!.click())
      await eventually(() => !!host.querySelector('dialog[open]'))
      assert(host.querySelector<HTMLInputElement>('dialog input[maxlength="100"]')?.value === 'Рубашка из магазина', 'Название покупки не перенесено')
      flushSync(() => host.querySelector<HTMLFormElement>('dialog form')!.requestSubmit())
      await eventually(() => !host.querySelector('dialog'))
      const things = await repository.list()
      const purchase = (await repository.listWishlist())[0]
      assert(things.length === 1 && things[0].name === 'Рубашка из магазина' && purchase.status === 'purchased' && purchase.garmentId === things[0].id, 'Перенос через интерфейс не завершился')
      assert(host.querySelector('#wd-tab-collection')?.getAttribute('aria-selected') === 'true', 'Коллекция не открылась после переноса')
    } finally { flushSync(() => root.unmount()); host.remove(); indexedDB.deleteDatabase(databaseName) }
  })
}
