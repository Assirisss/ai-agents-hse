import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { categories, colors, seasons } from './types'
import type { Garment, GarmentDraft, GarmentPhoto } from './types'
import { originalPhotoProcessor, PHOTO_ACCEPT, removePhotoBackground } from './photoProcessor'
import type { PhotoProgress } from './photoProcessor'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

const emptyDraft: GarmentDraft = {
  name: '', category: 'tops', color: 'black', season: 'all', brand: '', notes: '',
}

type Props = {
  garment: Garment | null
  initialDraft?: Partial<GarmentDraft>
  initialPhoto?: GarmentPhoto
  title?: string
  onSave: (draft: GarmentDraft, photo: GarmentPhoto) => Promise<void>
  onRemove: (() => Promise<void>) | undefined
  onDismiss: () => void
}

export default function GarmentEditor({ garment, initialDraft, initialPhoto, title, onSave, onRemove, onDismiss }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const photoRequest = useRef(0)
  const processingRequest = useRef<AbortController | null>(null)
  const id = useId()
  const [draft, setDraft] = useState<GarmentDraft>(() => garment ?? { ...emptyDraft, ...initialDraft })
  const [photo, setPhoto] = useState<GarmentPhoto | undefined>(garment?.photo ?? initialPhoto)
  const [readingPhoto, setReadingPhoto] = useState(false)
  const [removingBackground, setRemovingBackground] = useState(false)
  const [photoProgress, setPhotoProgress] = useState<PhotoProgress>('preparing')
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState('')
  const busy = saving || readingPhoto || removingBackground

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      photoRequest.current += 1
      processingRequest.current?.abort()
      dialog?.close()
    }
  }, [])

  function update<K extends keyof GarmentDraft>(key: K, value: GarmentDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }))
  }

  async function readPhoto(file: File | undefined) {
    if (!file) return
    const request = ++photoRequest.current
    setReadingPhoto(true)
    setError('')
    try {
      const result = await originalPhotoProcessor.process(file)
      if (photoRequest.current === request) setPhoto(result)
    } catch (cause) {
      if (photoRequest.current === request) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить фото.')
    } finally {
      if (photoRequest.current === request) setReadingPhoto(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!photo) { setError('Добавьте фотографию вещи.'); return }
    if (!draft.name.trim()) { setError('Укажите название вещи.'); return }
    setSaving(true)
    setError('')
    try {
      await onSave({ ...draft, name: draft.name.trim(), brand: draft.brand.trim(), notes: draft.notes.trim() }, photo)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить вещь.')
      setSaving(false)
    }
  }

  async function removeBackground() {
    if (!photo || busy) return
    const controller = new AbortController()
    processingRequest.current = controller
    const request = photoRequest.current
    setRemovingBackground(true)
    setError('')
    try {
      const result = await removePhotoBackground(photo.original, controller.signal, progress => {
        if (!controller.signal.aborted && photoRequest.current === request) setPhotoProgress(progress)
      })
      if (!controller.signal.aborted && photoRequest.current === request) setPhoto(result)
    } catch (cause) {
      if (!controller.signal.aborted && photoRequest.current === request) {
        setError(cause instanceof Error ? cause.message : 'Не удалось удалить фон. Оригинал сохранён.')
      }
    } finally {
      if (photoRequest.current === request) setRemovingBackground(false)
      if (processingRequest.current === controller) processingRequest.current = null
    }
  }

  async function remove() {
    if (!onRemove || busy) return
    setSaving(true)
    setError('')
    try {
      await onRemove()
    } catch {
      setError('Не удалось удалить вещь. Попробуйте ещё раз.')
      setSaving(false)
    }
  }

  return (
    <dialog className="wd-dialog" ref={dialogRef} aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}>
      <form onSubmit={submit}>
        <header className="wd-dialog-header">
          <div><p className="wd-kicker">ЛИЧНАЯ КОЛЛЕКЦИЯ</p><h2 id={`${id}-title`}>{title ?? (garment ? 'Детали вещи' : 'Новая вещь')}</h2></div>
          <button className="wd-icon-button" type="button" onClick={onDismiss} disabled={busy} aria-label="Закрыть"><WardrobeIcon name="close" /></button>
        </header>
        <div className="wd-editor-body">
          <div className="wd-photo-column">
            <input ref={fileRef} type="file" accept={PHOTO_ACCEPT} hidden disabled={busy} onChange={event => { void readPhoto(event.target.files?.[0]); event.target.value = '' }} />
            <button type="button" className={`wd-photo-upload ${photo ? 'wd-photo-upload-filled' : ''}`} disabled={busy}
              onClick={() => fileRef.current?.click()}
              onDragOver={event => event.preventDefault()}
              onDrop={event => { event.preventDefault(); if (!busy) void readPhoto(event.dataTransfer.files[0]) }}>
              {photo ? <><PhotoImage blob={photo.display} alt="Фото добавляемой вещи" /><span className="wd-photo-replace">Заменить фото</span></> :
                <><span className="wd-upload-symbol"><WardrobeIcon name="upload" size={28} /></span><strong>{readingPhoto ? 'Читаем фото…' : 'Добавить фото'}</strong><span>Перетащите сюда<br />или выберите на устройстве</span><small>JPG, PNG, WebP · до 15 МБ</small></>}
            </button>
            {photo ? <div className="wd-photo-actions">
              {removingBackground ? <button className="wd-secondary" type="button" onClick={() => processingRequest.current?.abort()}>Отменить обработку</button>
                : photo.processing === 'background-removed' ? <button className="wd-secondary" type="button" disabled={busy} onClick={() => { setPhoto({ original: photo.original, display: photo.original, processing: 'original' }); setError('') }}>Вернуть оригинал</button>
                  : <button className="wd-secondary" type="button" disabled={busy} onClick={() => void removeBackground()}>Удалить фон</button>}
            </div> : null}
            <p className="wd-photo-note" role="status" aria-live="polite">{removingBackground ? photoProgress === 'queued' ? 'Фото в очереди. Первый запуск может занять несколько минут…' : photoProgress === 'running' ? 'Удаляем фон…' : 'Подготавливаем фото…'
              : photo?.processing === 'background-removed' ? 'Фон удалён. Оригинал сохранён.'
                : 'По кнопке «Удалить фон» фото отправится на обработку в Runpod. Оригинал сохранится.'}</p>
          </div>
          <div className="wd-fields">
            <label htmlFor={`${id}-name`}>Название<input id={`${id}-name`} value={draft.name} onChange={event => update('name', event.target.value)} placeholder="Например, льняная рубашка" maxLength={100} required autoFocus /></label>
            <label htmlFor={`${id}-category`}>Категория<select id={`${id}-category`} value={draft.category} onChange={event => update('category', event.target.value as GarmentDraft['category'])}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="wd-field-pair">
              <label htmlFor={`${id}-color`}>Цвет<select id={`${id}-color`} value={draft.color} onChange={event => update('color', event.target.value as GarmentDraft['color'])}>{Object.entries(colors).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label htmlFor={`${id}-season`}>Сезон<select id={`${id}-season`} value={draft.season} onChange={event => update('season', event.target.value as GarmentDraft['season'])}>{Object.entries(seasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
            <label htmlFor={`${id}-brand`}>Бренд <span className="wd-optional">необязательно</span><input id={`${id}-brand`} value={draft.brand} onChange={event => update('brand', event.target.value)} placeholder="Название бренда" maxLength={80} /></label>
            <label htmlFor={`${id}-notes`}>Заметка <span className="wd-optional">необязательно</span><textarea id={`${id}-notes`} value={draft.notes} onChange={event => update('notes', event.target.value)} placeholder="Посадка, материал, с чем нравится носить…" rows={3} maxLength={1000} /></label>
          </div>
        </div>
        <div className="wd-editor-feedback" role="status" aria-live="polite">{error}</div>
        <footer className="wd-dialog-footer">
          {onRemove ? <div className="wd-remove-actions">{confirmRemove ? <><span>Удалить вещь?</span><button className="wd-danger-button" type="button" disabled={busy} onClick={() => void remove()}>Да, удалить</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Отмена</button></> : <button type="button" className="wd-danger-button" disabled={busy} onClick={() => setConfirmRemove(true)}>Удалить вещь</button>}</div> : <span className="wd-footer-hint">Одна фотография — одна вещь</span>}
          <button className="wd-primary" type="submit" disabled={busy}>{saving ? 'Сохраняем…' : garment ? 'Сохранить изменения' : 'В гардероб'}<WardrobeIcon name={garment ? 'check' : 'plus'} size={18} /></button>
        </footer>
      </form>
    </dialog>
  )
}
