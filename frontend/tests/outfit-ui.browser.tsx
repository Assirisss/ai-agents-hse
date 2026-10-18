import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import OutfitBoard from '../src/modules/wardrobe/OutfitBoard'
import OutfitEditor from '../src/modules/wardrobe/OutfitEditor'
import type { Garment, OutfitDraft, OutfitLayer } from '../src/modules/wardrobe/types'
import type { BrowserCheck } from './outfits.browser'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export async function runOutfitUIChecks(check: BrowserCheck, garment: Garment) {
  await check('Перетаскивание переводит смещение в координаты доски и заканчивается при отпускании', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let layers: OutfitLayer[] = [{ garmentId: garment.id, x: 5, y: 8, size: 40 }]
    function render() { root.render(<OutfitBoard garments={[garment]} layers={layers} onSelect={() => undefined} onChange={next => { layers = next; render() }} />) }
    try {
      flushSync(render)
      const board = host.querySelector<HTMLElement>('.wd-board')!
      board.style.width = '400px'
      board.style.height = '500px'
      const button = host.querySelector('button')!
      // Synthetic pointer events have no UA-owned pointer to capture. Only capture is stubbed.
      button.setPointerCapture = () => undefined
      const pointer = { pointerId: 1, isPrimary: true, button: 0, bubbles: true }
      flushSync(() => button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 10, clientY: 10 })))
      flushSync(() => button.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 50, clientY: 60 })))
      assert(layers[0].x === 15 && layers[0].y === 18, 'Смещение не соответствует масштабу доски')
      flushSync(() => button.dispatchEvent(new PointerEvent('pointerup', pointer)))
      flushSync(() => button.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 90, clientY: 110 })))
      assert(layers[0].x === 15 && layers[0].y === 18, 'Вещь продолжила двигаться после отпускания')
    } finally { flushSync(() => root.unmount()); host.remove() }
  })
  await check('Доска управляется стрелками и Shift; вещь остаётся в границах', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let layers: OutfitLayer[] = [{ garmentId: garment.id, x: 59, y: 8, size: 40 }]
    function render() {
      root.render(<OutfitBoard garments={[garment]} layers={layers} onSelect={() => undefined} onChange={next => { layers = next; render() }} />)
    }
    try {
      flushSync(render)
      const button = host.querySelector('button')!
      flushSync(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })))
      assert(layers[0].x === 60, 'Клавиатура вывела вещь за границы')
      flushSync(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true })))
      assert(layers[0].y === 3, 'Shift со стрелкой не сдвинул вещь на 5 единиц')
    } finally { flushSync(() => root.unmount()); host.remove() }
  })

  await check('Редактор: выбор вещи, размер, защита несохранённого образа и сохранение', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let saved: OutfitDraft | undefined
    let cancelled = false
    try {
      flushSync(() => root.render(<OutfitEditor outfit={null} garments={[garment]} onSave={async draft => { saved = draft }} onRemove={undefined} onCancel={() => { cancelled = true }} />))
      const name = host.querySelector<HTMLInputElement>('input[maxlength="100"]')!
      flushSync(() => setInput(name, 'Образ из теста'))
      const add = host.querySelector<HTMLButtonElement>('.wd-item-palette button')!
      flushSync(() => add.click())
      const size = host.querySelector<HTMLInputElement>('input[type="range"]')!
      flushSync(() => setInput(size, '60'))
      const cancel = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'К образам')!
      flushSync(() => cancel.click())
      assert(!cancelled && host.querySelector('.wd-inline-confirm'), 'Изменения потеряны без предупреждения')
      const continueEditing = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Продолжить редактирование')!
      flushSync(() => continueEditing.click())
      flushSync(() => host.querySelector('form')!.requestSubmit())
      await Promise.resolve()
      assert(saved?.name === 'Образ из теста' && saved.layers.length === 1 && saved.layers[0].size === 60, 'Форма не сохранила название, состав или размер')
    } finally { flushSync(() => root.unmount()); host.remove() }
  })
}
