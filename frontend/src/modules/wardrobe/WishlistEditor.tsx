import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { categories, currencies, priorities } from './types'
import type { WishlistDraft, WishlistItem } from './types'
import { parsePrice, validateWishlist } from './wishlistDomain'
import { originalPhotoProcessor, PHOTO_ACCEPT } from './photoProcessor'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

type Props = { item: WishlistItem | null; onSave: (draft: WishlistDraft) => Promise<void>; onRemove?: () => Promise<void>; onDismiss: () => void }

export default function WishlistEditor({ item, onSave, onRemove, onDismiss }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const id = useId()
  const [draft, setDraft] = useState<WishlistDraft>(() => item ?? { name: '', category: 'tops', priceMinor: null, currency: 'RUB', priority: 'normal', url: '', notes: '' })
  const [price, setPrice] = useState(item?.priceMinor == null ? '' : String(item.priceMinor / 100).replace('.', ','))
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => { request.current += 1; dialog?.close() }
  }, [])

  function update<K extends keyof WishlistDraft>(key: K, value: WishlistDraft[K]) { setDraft(current => ({ ...current, [key]: value })) }

  async function read(file: File | undefined) {
    if (!file) return
    const current = ++request.current
    setReading(true)
    setError('')
    try {
      const photo = await originalPhotoProcessor.process(file)
      if (request.current === current) update('photo', photo)
    } catch (cause) { if (request.current === current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить фото.') }
    finally { if (request.current === current) setReading(false) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || reading) return
    setError('')
    try {
      const value = validateWishlist({ ...draft, priceMinor: parsePrice(price) })
      setBusy(true)
      await onSave(value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить покупку.'); setBusy(false) }
  }

  async function remove() {
    if (!onRemove || busy || reading) return
    setBusy(true)
    try { await onRemove() } catch { setError('Не удалось удалить покупку.'); setBusy(false) }
  }

  return (
    <dialog className="wd-dialog wd-wishlist-dialog" ref={ref} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy && !reading) onDismiss() }}>
      <form onSubmit={submit}>
        <header className="wd-dialog-header"><div><p className="wd-kicker">СПИСОК ЖЕЛАНИЙ</p><h2 id={`${id}-title`}>{item ? 'Детали покупки' : 'Хочу купить'}</h2></div><button className="wd-icon-button" type="button" aria-label="Закрыть" disabled={busy || reading} onClick={onDismiss}><WardrobeIcon name="close" /></button></header>
        <fieldset disabled={busy || reading} className="wd-outfit-fieldset">
          <div className="wd-editor-body">
            <div className="wd-photo-column"><input ref={fileRef} type="file" accept={PHOTO_ACCEPT} hidden onChange={event => { void read(event.target.files?.[0]); event.target.value = '' }} />
              <button type="button" className={`wd-photo-upload ${draft.photo ? 'wd-photo-upload-filled' : ''}`} onClick={() => fileRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!reading && !busy) void read(event.dataTransfer.files[0]) }}>
                {draft.photo ? <><PhotoImage blob={draft.photo.display} alt="Фото желаемой покупки" /><span className="wd-photo-replace">Заменить фото</span></> : <><span className="wd-upload-symbol"><WardrobeIcon name="bag" size={30} /></span><strong>{reading ? 'Читаем фото…' : 'Добавить фото'}</strong><span>Можно сохранить покупку<br />и без фотографии</span><small>JPG, PNG, WebP · до 15 МБ</small></>}
              </button>
              {draft.photo ? <button type="button" className="wd-text-button" onClick={() => update('photo', undefined)}>Убрать фотографию</button> : null}
              <p className="wd-photo-note">Сохраните идею сейчас. Детали можно добавить позже.</p>
            </div>
            <div className="wd-fields">
              <label>Название<input value={draft.name} onChange={event => update('name', event.target.value)} maxLength={100} required autoFocus placeholder="Например, кожаная сумка" /></label>
              <label>Категория<select value={draft.category} onChange={event => update('category', event.target.value as WishlistDraft['category'])}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <div className="wd-field-pair"><label>Цена<input value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" placeholder="Не указана" /></label><label>Валюта<select value={draft.currency} onChange={event => update('currency', event.target.value as WishlistDraft['currency'])}>{Object.entries(currencies).map(([value, symbol]) => <option key={value} value={value}>{value} · {symbol}</option>)}</select></label></div>
              <label>Приоритет<select value={draft.priority} onChange={event => update('priority', event.target.value as WishlistDraft['priority'])}>{Object.entries(priorities).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>Ссылка на магазин<input type="url" value={draft.url} onChange={event => update('url', event.target.value)} placeholder="https://" maxLength={2000} /></label>
              <label>Заметка<textarea value={draft.notes} onChange={event => update('notes', event.target.value)} maxLength={1000} rows={2} placeholder="Размер, материал, с чем хочется носить…" /></label>
            </div>
          </div>
        </fieldset>
        <p className="wd-editor-feedback" role="status" aria-live="polite">{error}</p>
        <footer className="wd-dialog-footer">{onRemove ? <div className="wd-remove-actions">{confirmRemove ? <><span>Удалить из списка?</span><button type="button" className="wd-danger-button" disabled={busy || reading} onClick={() => void remove()}>Да, удалить</button><button type="button" onClick={() => setConfirmRemove(false)}>Отмена</button></> : <button type="button" className="wd-danger-button" disabled={busy || reading} onClick={() => setConfirmRemove(true)}>Удалить покупку</button>}</div> : <span className="wd-footer-hint">Фото и цена необязательны</span>}<button type="submit" className="wd-primary" disabled={busy || reading}>{busy ? 'Сохраняем…' : 'Сохранить'}<WardrobeIcon name="check" size={17} /></button></footer>
      </form>
    </dialog>
  )
}
