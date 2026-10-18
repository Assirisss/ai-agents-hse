import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Category, Garment, Outfit, OutfitDraft, OutfitLayer } from './types'
import { categories } from './types'
import { arrangeOutfitLayers, fitLayer, MAX_LAYER_SIZE, MAX_OUTFIT_ITEMS, MIN_LAYER_SIZE, validateOutfit } from './outfitDomain'
import { useLayerHistory } from './useLayerHistory'
import OutfitBoard from './OutfitBoard'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

type Props = {
  outfit: Outfit | null
  initialDraft?: OutfitDraft
  garments: Garment[]
  onSave: (draft: OutfitDraft) => Promise<void>
  onCancel: () => void
  onRemove: (() => Promise<void>) | undefined
}

export default function OutfitEditor({ outfit, initialDraft, garments, onSave, onCancel, onRemove }: Props) {
  const [details, setDraft] = useState(() => ({ name: outfit?.name ?? initialDraft?.name ?? '', notes: outfit?.notes ?? initialDraft?.notes ?? '' }))
  const history = useLayerHistory(outfit?.layers ?? initialDraft?.layers ?? [])
  const draft: OutfitDraft = { ...details, layers: history.layers }
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const selectedLayer = draft.layers.find(layer => layer.garmentId === selected)
  const selectedGarment = garments.find(item => item.id === selected)
  const baseline = outfit ? { name: outfit.name, notes: outfit.notes, layers: outfit.layers } : { name: '', notes: '', layers: [] }
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const query = search.trim().toLocaleLowerCase('ru')
  const available = garments.filter(item => (category === 'all' || item.category === category) && `${item.name} ${item.brand}`.toLocaleLowerCase('ru').includes(query))

  function setLayers(layers: OutfitLayer[]) { history.set(layers); setError('') }

  function addOrSelect(garment: Garment) {
    if (draft.layers.some(layer => layer.garmentId === garment.id)) { setSelected(garment.id); return }
    if (draft.layers.length >= MAX_OUTFIT_ITEMS) { setError(`На доске может быть до ${MAX_OUTFIT_ITEMS} вещей.`); return }
    const index = draft.layers.length % 4
    const positions = [[7, 7], [47, 40], [5, 53], [62, 5]]
    const size = garment.category === 'accessories' || garment.category === 'bags' || garment.category === 'shoes' ? 28 : 43
    setLayers([...draft.layers, fitLayer({ garmentId: garment.id, x: positions[index][0], y: positions[index][1], size })])
    setSelected(garment.id)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const value = validateOutfit(draft)
      setBusy(true)
      await onSave(value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить образ.')
      setBusy(false)
    }
  }

  async function remove() {
    if (!onRemove || busy) return
    setBusy(true)
    setError('')
    try { await onRemove() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось удалить образ.')
      setBusy(false)
    }
  }

  return (
    <form className="wd-outfit-editor" onSubmit={submit} onKeyDown={event => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement
      if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) event.currentTarget.requestSubmit(); return }
      if (busy || target.matches('input:not([type="range"]), textarea, select') || target.isContentEditable) return
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo() }
      else if (event.key.toLowerCase() === 'y') { event.preventDefault(); history.redo() }
    }}>
      <div className="wd-section-heading">
        <div><p className="wd-kicker">ДОСКА ВАШЕГО СТИЛЯ</p><h2>{outfit ? 'Редактировать образ' : 'Собрать новый образ'}</h2></div>
        <div className="wd-inline-actions">
          <button type="button" className="wd-secondary" disabled={busy} onClick={() => { if (dirty) setConfirmCancel(true); else onCancel() }}>К образам</button>
          <button className="wd-primary" disabled={busy} type="submit"><WardrobeIcon name="check" size={17} />{busy ? 'Сохраняем…' : 'Сохранить образ'}</button>
        </div>
      </div>
      {confirmCancel ? <div className="wd-inline-confirm" role="alert"><span>Изменения ещё не сохранены. Выйти из редактора?</span><button type="button" className="wd-danger-button" onClick={onCancel}>Выйти без сохранения</button><button type="button" onClick={() => setConfirmCancel(false)}>Продолжить редактирование</button></div> : null}
      <p className="wd-editor-feedback" role="status" aria-live="polite">{error}</p>
      <fieldset disabled={busy} className="wd-outfit-fieldset">
        <legend className="wd-sr-only">Состав и оформление образа</legend>
        <div className="wd-outfit-workspace">
          <div className="wd-outfit-canvas">
            <div className="wd-canvas-toolbar"><div className="wd-undo-group"><button type="button" className="wd-icon-button" aria-label="Отменить изменение доски" title="Отменить · ⌘Z" disabled={!history.canUndo} onClick={history.undo}><WardrobeIcon name="undo" size={18} /></button><button type="button" className="wd-icon-button" aria-label="Повторить изменение доски" title="Повторить · ⇧⌘Z" disabled={!history.canRedo} onClick={history.redo}><WardrobeIcon name="redo" size={18} /></button></div><span>{draft.layers.length} / {MAX_OUTFIT_ITEMS} вещей</span><button type="button" className="wd-text-button" disabled={!draft.layers.length} onClick={() => setLayers(arrangeOutfitLayers(draft.layers.map(layer => layer.garmentId), garments))}><WardrobeIcon name="grid" size={15} />Разложить</button></div>
            <OutfitBoard layers={draft.layers} garments={garments} selected={selected} onSelect={setSelected} onChange={setLayers} onInteractionStart={history.begin} onInteractionEnd={history.end} />
          </div>
          <aside className="wd-outfit-sidebar" aria-label="Детали образа и выбор вещей">
            {selectedLayer ? <div className="wd-layer-controls">
              <strong>{selectedGarment?.name ?? 'Вещь удалена из гардероба'}</strong>
              <label>Размер <input aria-label="Размер выбранной вещи" type="range" onPointerDown={history.begin} onPointerUp={history.end} onPointerCancel={history.end} onLostPointerCapture={history.end} onBlur={history.end} min={MIN_LAYER_SIZE} max={MAX_LAYER_SIZE} value={selectedLayer.size} onChange={event => setLayers(draft.layers.map(layer => layer.garmentId === selected ? fitLayer({ ...layer, size: Number(event.target.value) }) : layer))} /><span>{selectedLayer.size}%</span></label>
              <div className="wd-inline-actions"><button type="button" className="wd-secondary" onClick={() => setLayers([...draft.layers.filter(layer => layer.garmentId !== selected), selectedLayer])}>На передний план</button><button type="button" className="wd-danger-button" onClick={() => { setLayers(draft.layers.filter(layer => layer.garmentId !== selected)); setSelected(null) }}>Убрать с доски</button></div>
            </div> : <p className="wd-selection-hint">Выберите вещь на доске, чтобы изменить её размер или порядок.</p>}
            <div className="wd-fields">
              <label>Название образа<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="Например, неспешное воскресенье" maxLength={100} required /></label>
              <label>Заметка<textarea value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} placeholder="Куда носить, настроение, детали…" maxLength={1000} rows={2} /></label>
            </div>
            <div className="wd-palette-heading"><h3>Вещи из гардероба</h3><span>Нажмите, чтобы добавить</span></div>
            <div className="wd-fields wd-palette-filters"><input aria-label="Поиск вещей для образа" value={search} placeholder="Название или бренд" onChange={event => setSearch(event.target.value)} /><select aria-label="Категория вещей для образа" value={category} onChange={event => setCategory(event.target.value as Category | 'all')}><option value="all">Все категории</option>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="wd-item-palette">{available.length ? available.map(garment => {
              const included = draft.layers.some(layer => layer.garmentId === garment.id)
              return <button type="button" key={garment.id} onClick={() => addOrSelect(garment)} aria-label={included ? `Выбрать на доске: ${garment.name}` : `Добавить на доску: ${garment.name}`} className={included ? 'is-included' : ''}>
                <span className="wd-palette-photo"><PhotoImage blob={garment.photo.display} alt="" lazy /><span><WardrobeIcon name={included ? 'check' : 'plus'} size={14} /></span></span><strong>{garment.name}</strong><small>{included ? 'На доске' : categories[garment.category]}</small>
              </button>
            }) : <p className="wd-palette-empty">{garments.length ? 'По этим фильтрам вещей нет.' : 'Сначала добавьте вещи во вкладке «Мои вещи».'}</p>}</div>
          </aside>
        </div>
      </fieldset>
      <footer className="wd-outfit-footer"><span>Сохраняются вещи, их расположение, размер и порядок слоёв.</span>{onRemove ? confirmRemove ? <div className="wd-inline-actions"><span>История носки сохранится.</span><button type="button" className="wd-danger-button" disabled={busy} onClick={() => void remove()}>Да, удалить образ</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Отмена</button></div> : <button type="button" className="wd-danger-button" disabled={busy} onClick={() => setConfirmRemove(true)}>Удалить образ</button> : null}</footer>
    </form>
  )
}
