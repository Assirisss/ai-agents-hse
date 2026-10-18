import { useState } from 'react'
import type { Garment, Outfit, OutfitDraft, WearEvent } from './types'
import { arrangeOutfitLayers, combinationKey, formatWearDate } from './outfitDomain'
import OutfitBoard from './OutfitBoard'
import OutfitEditor from './OutfitEditor'
import WardrobeIcon from './WardrobeIcon'

type Props = {
  garments: Garment[]
  outfits: Outfit[]
  events: WearEvent[]
  today: string
  onSave: (draft: OutfitDraft, previous: Outfit | null) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onWear: (id: string, date: string) => Promise<void>
  onCollection: () => void
  initialGarmentIds?: string[]
}

export default function OutfitsView({ garments, outfits, events, today, onSave, onRemove, onWear, onCollection, initialGarmentIds }: Props) {
  const [editor, setEditor] = useState<{ outfit: Outfit | null; initialDraft?: OutfitDraft } | null>(() => initialGarmentIds?.length ? { outfit: null, initialDraft: { name: '', notes: '', layers: arrangeOutfitLayers(initialGarmentIds, garments) } } : null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState('newest')
  const search = query.trim().toLocaleLowerCase('ru')
  const visible = outfits.filter(outfit => `${outfit.name} ${outfit.notes}`.toLocaleLowerCase('ru').includes(search)).sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'ru') : order === 'worn' ? events.filter(event => event.combinationKey === combinationKey(b.layers)).length - events.filter(event => event.combinationKey === combinationKey(a.layers)).length : b.updatedAt.localeCompare(a.updatedAt))
  const garmentIds = new Set(garments.map(item => item.id))

  async function wear(id: string) {
    if (pending) return
    setPending(id)
    setError('')
    try { await onWear(id, today) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отметить выход.') }
    finally { setPending(null) }
  }

  if (editor) return <OutfitEditor key={editor.outfit?.id ?? 'new'} outfit={editor.outfit} initialDraft={editor.initialDraft} garments={garments}
    onSave={async draft => { await onSave(draft, editor.outfit); setQuery(''); setEditor(null) }}
    onRemove={editor.outfit ? async () => { await onRemove(editor.outfit!.id); setEditor(null) } : undefined}
    onCancel={() => setEditor(null)} />

  return (
    <div className="wd-outfits-view">
      <div className="wd-section-heading"><div><h2>Готовые образы</h2><p>Сохранённые сочетания для вашего дня.</p></div><button className="wd-primary" disabled={!garments.length} onClick={() => { setError(''); setEditor({ outfit: null }) }}><WardrobeIcon name="plus" size={18} />Собрать образ</button></div>
      {outfits.length ? <div className="wd-view-toolbar"><label className="wd-search"><WardrobeIcon name="search" size={17} /><input aria-label="Поиск образов" placeholder="Найти образ" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="wd-filter"><span className="wd-sr-only">Порядок образов</span><select value={order} onChange={event => setOrder(event.target.value)}><option value="newest">Недавно изменённые</option><option value="name">По названию</option><option value="worn">Чаще ношу</option></select></label></div> : null}
      {outfits.length && !visible.length ? <div className="wd-message"><h2>Образ не найден</h2><button className="wd-secondary" onClick={() => setQuery('')}>Сбросить поиск</button></div> : null}
      <p className="wd-view-error" role="status" aria-live="polite">{error}</p>
      {outfits.length ? <div className="wd-outfits-grid">{visible.map(outfit => {
        const key = combinationKey(outfit.layers)
        const wears = events.filter(event => event.combinationKey === key)
        const wornToday = wears.some(event => event.date === today)
        const missing = outfit.layers.some(layer => !garmentIds.has(layer.garmentId))
        const lastDate = wears.reduce<string | null>((last, event) => last === null || event.date > last ? event.date : last, null)
        return <article className="wd-outfit-card" key={outfit.id}>
          <button className="wd-outfit-preview" onClick={() => { setError(''); setEditor({ outfit }) }} aria-label={`Редактировать образ: ${outfit.name}`}><OutfitBoard layers={outfit.layers} garments={garments} /><span className="wd-outfit-preview-label">{outfit.layers.length} вещей<WardrobeIcon name="arrow" size={16} /></span></button>
          <div className="wd-outfit-card-body"><div className="wd-outfit-card-title"><h3>{outfit.name}</h3><button className="wd-icon-button" aria-label={`Создать копию: ${outfit.name}`} title="Создать копию" onClick={() => setEditor({ outfit: null, initialDraft: { name: `${outfit.name.slice(0, 88)} — копия`, notes: outfit.notes, layers: outfit.layers.map(layer => ({ ...layer })) } })}><WardrobeIcon name="copy" size={16} /></button></div>{outfit.notes ? <p className="wd-outfit-notes">{outfit.notes}</p> : null}<p className="wd-outfit-wears">Дней в этом сочетании: <strong>{wears.length}</strong><span>{lastDate ? `Последний выход: ${formatWearDate(lastDate)}` : 'Первый выход ещё впереди'}</span></p>{missing ? <p className="wd-view-error">Вещь удалена из каталога. Измените состав образа.</p> : null}<div className="wd-outfit-card-actions"><button className={wornToday ? 'wd-worn-button' : 'wd-secondary'} disabled={!!pending || wornToday || missing} onClick={() => void wear(outfit.id)}><WardrobeIcon name="check" size={16} />{pending === outfit.id ? 'Отмечаем…' : wornToday ? 'Надет сегодня' : 'Надел сегодня'}</button><button className="wd-text-button" onClick={() => { setError(''); setEditor({ outfit }) }}>Изменить</button></div></div>
        </article>
      })}</div> : <div className="wd-outfit-empty"><div className="wd-outfit-empty-art" aria-hidden="true"><span>ВЕРХ</span><span>НИЗ</span><span>ДЕТАЛИ</span></div><h2>Ваш следующий образ</h2><p>Выберите вещи из коллекции и расположите на доске. Сохраните сочетание, к которому захочется вернуться.</p><button className="wd-primary" onClick={() => { if (garments.length) setEditor({ outfit: null }); else onCollection() }}>{garments.length ? 'Собрать первый образ' : 'Добавить вещи в коллекцию'}<WardrobeIcon name="arrow" size={18} /></button></div>}
    </div>
  )
}
