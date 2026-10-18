import { Activity, lazy, Suspense, useEffect, useState } from 'react'
import type { WardrobeAction } from '../../../../shared/wardrobe-agent'
import type { Garment, GarmentDraft, GarmentPhoto, Outfit, OutfitDraft, WardrobeRepository, WearEvent, WishlistDraft, WishlistItem } from './types'
import { browserWardrobeRepository } from './repository'
import GarmentEditor from './GarmentEditor'
import WardrobeIcon from './WardrobeIcon'
import CollectionView from './CollectionView'
import OutfitsView from './OutfitsView'
import WearHistory from './WearHistory'
import WishlistView from './WishlistView'
import { useLocalDate } from './useLocalDate'
import './wardrobe.css'
import './outfits.css'
import './apple.css'

const WardrobeChat = lazy(() => import('./WardrobeChat'))

const tabs = [
  { id: 'collection', label: 'Мои вещи', icon: 'hanger' },
  { id: 'outfits', label: 'Образы', icon: 'layers' },
  { id: 'history', label: 'История', icon: 'clock' },
  { id: 'wishlist', label: 'Хочу купить', icon: 'bag' },
  { id: 'stylist', label: 'Стилист', icon: 'sparkles' },
] as const
type View = typeof tabs[number]['id']
type Editor = { garment: Garment | null; purchaseId?: string; agentAction?: WardrobeAction & { kind: 'garment' }; onAgentSaved?: (message: string) => void }

export default function WardrobePage({ repository = browserWardrobeRepository }: { repository?: WardrobeRepository } = {}) {
  const [garments, setGarments] = useState<Garment[]>([])
  const [outfits, setOutfits] = useState<Outfit[]>([])
  const [wearEvents, setWearEvents] = useState<WearEvent[]>([])
  const [wishlist, setWishlist] = useState<WishlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<View>('collection')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [collectionVersion, setCollectionVersion] = useState(0)
  const [outfitSeed, setOutfitSeed] = useState<{ key: string; ids: string[] }>()
  const today = useLocalDate()

  useEffect(() => {
    let active = true
    Promise.all([repository.list(), repository.listOutfits(), repository.listWearEvents(), repository.listWishlist()])
      .then(([items, savedOutfits, history, purchases]) => {
        if (!active) return
        setGarments(items)
        setOutfits(savedOutfits)
        setWearEvents(history)
        setWishlist(purchases)
        setLoading(false)
      }).catch(() => {
        if (!active) return
        setLoadError('Не удалось открыть гардероб. Разрешите сохранение данных сайта и попробуйте снова.')
        setLoading(false)
      })
    return () => { active = false }
  }, [retry, repository])

  function navigate(next: View) { setView(next); setNotice('') }
  function openEditor(garment: Garment | null = null) { setNotice(''); setEditor({ garment }) }
  function createFromSelection(ids: string[]) {
    setOutfitSeed({ key: crypto.randomUUID(), ids })
    navigate('outfits')
  }

  async function saveGarment(draft: GarmentDraft, photo: GarmentPhoto) {
    if (editor?.agentAction) {
      const message = await repository.applyAgentAction({ ...editor.agentAction, draft }, photo)
      editor.onAgentSaved?.(message)
      await refreshAfterAgent()
      setCollectionVersion(current => current + 1)
      setNotice(message)
      setEditor(null)
      return
    }
    const now = new Date().toISOString()
    let garment: Garment = { ...draft, photo, id: editor?.garment?.id ?? crypto.randomUUID(), createdAt: editor?.garment?.createdAt ?? now, updatedAt: now }
    if (editor?.purchaseId) {
      const result = await repository.purchaseWishlistItem(editor.purchaseId, garment)
      garment = result.garment
      setWishlist(current => current.map(item => item.id === result.item.id ? result.item : item))
      setNotice('Покупка добавлена в гардероб.')
      setView('collection')
    } else {
      await repository.save(garment)
      setNotice(editor?.garment ? 'Изменения сохранены.' : 'Новая вещь в вашей коллекции.')
    }
    setGarments(current => [garment, ...current.filter(item => item.id !== garment.id)])
    if (!editor?.garment) setCollectionVersion(current => current + 1)
    setEditor(null)
  }

  async function removeGarment() {
    if (!editor?.garment) return
    const id = editor.garment.id
    await repository.remove(id)
    setGarments(current => current.filter(item => item.id !== id))
    setNotice('Вещь удалена. История носки сохранена.')
    setEditor(null)
  }

  async function saveOutfit(draft: OutfitDraft, previous: Outfit | null) {
    const now = new Date().toISOString()
    const outfit: Outfit = { ...draft, id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now }
    await repository.saveOutfit(outfit)
    setOutfits(current => [outfit, ...current.filter(item => item.id !== outfit.id)])
    setNotice(previous ? 'Образ обновлён.' : 'Новый образ сохранён.')
  }

  async function removeOutfit(id: string) {
    await repository.removeOutfit(id)
    setOutfits(current => current.filter(item => item.id !== id))
    setNotice('Образ удалён. Прошлые выходы остались в истории.')
  }

  async function recordWear(id: string, date: string) {
    const event = await repository.recordWear(id, date)
    setWearEvents(current => [event, ...current.filter(item => item.id !== event.id)].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)))
    setNotice(wearEvents.some(item => item.id === event.id) ? 'Это сочетание уже отмечено на выбранную дату.' : 'Выход отмечен. Статистика обновлена.')
  }

  async function removeWearEvent(id: string) {
    await repository.removeWearEvent(id)
    setWearEvents(current => current.filter(item => item.id !== id))
    setNotice('Отметка отменена. Статистика пересчитана.')
  }

  async function savePurchase(draft: WishlistDraft, previous: WishlistItem | null) {
    const now = new Date().toISOString()
    const item = await repository.saveWishlistItem({ ...draft, id: previous?.id ?? crypto.randomUUID(), status: previous?.status ?? 'planned', garmentId: previous?.garmentId, createdAt: previous?.createdAt ?? now, updatedAt: now })
    setWishlist(current => [item, ...current.filter(value => value.id !== item.id)])
    setNotice(previous ? 'Покупка обновлена.' : 'Сохранено в списке желаний.')
  }

  async function removePurchase(id: string) {
    await repository.removeWishlistItem(id)
    setWishlist(current => current.filter(item => item.id !== id))
    setNotice('Покупка удалена из списка.')
  }

  async function refreshAfterAgent() {
    try {
      const [items, savedOutfits, history, purchases] = await Promise.all([repository.list(), repository.listOutfits(), repository.listWearEvents(), repository.listWishlist()])
      setGarments(items); setOutfits(savedOutfits); setWearEvents(history); setWishlist(purchases)
    } catch { setNotice('Изменения сохранены. Обновите страницу, чтобы перечитать коллекцию.') }
  }

  async function applyAgentAction(action: WardrobeAction, photo?: GarmentPhoto) {
    const message = await repository.applyAgentAction(action, photo)
    await refreshAfterAgent()
    if (action.kind === 'update' || action.kind === 'garment') setCollectionVersion(current => current + 1)
    return message
  }

  const planned = wishlist.filter(item => item.status === 'planned').length
  const purchase = editor?.purchaseId ? wishlist.find(item => item.id === editor.purchaseId) : undefined
  const ready = !loading && !loadError

  return (
    <section className="wd-page wd-apple" aria-labelledby="wardrobe-title">
      <header className="wd-page-header">
        <div><p className="eyebrow">Личное пространство</p><h1 className="screen-title" id="wardrobe-title">Гардероб</h1><p className="body-2">Ваши вещи. Любимые сочетания. Каждый день.</p></div>
        <div className="wd-header-actions"><span className="wd-device-note" title="Коллекция сохраняется только в этом браузере"><span />На этом устройстве</span><button className="wd-primary" disabled={!ready} onClick={() => openEditor()}><WardrobeIcon name="plus" size={18} />Добавить вещь</button></div>
      </header>

      <div className="wd-summary-cards">
        {([{ id: 'collection', count: garments.length, label: 'Вещей в коллекции', detail: 'Всё, что нравится носить', icon: 'hanger' }, { id: 'outfits', count: outfits.length, label: 'Готовых образов', detail: 'Сочетания на ваш день', icon: 'layers' }, { id: 'wishlist', count: planned, label: 'В списке желаний', detail: 'Будущие любимые вещи', icon: 'bag' }] as const).map(card => <button key={card.id} onClick={() => navigate(card.id)} className={`wd-summary-card wd-summary-${card.id}`} disabled={!ready}><span className="wd-summary-icon"><WardrobeIcon name={card.icon} size={23} /></span><span className="wd-summary-card-copy"><strong>{ready ? card.count : '—'}<span>{card.label}</span></strong><small>{card.detail}</small></span><WardrobeIcon name="arrow" size={17} /></button>)}
      </div>

      <div className="wd-navigation" role="tablist" aria-label="Разделы гардероба" onKeyDown={event => {
        const index = tabs.findIndex(tab => tab.id === view)
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
        if (next < 0) return
        event.preventDefault()
        navigate(tabs[next].id)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {tabs.map(tab => <button key={tab.id} role="tab" id={`wd-tab-${tab.id}`} aria-controls={`wd-panel-${tab.id}`} aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} className={view === tab.id ? 'is-active' : ''} onClick={() => navigate(tab.id)}><WardrobeIcon name={tab.icon} size={17} /><span>{tab.label}</span></button>)}
      </div>

      {loading ? <div className="wd-message" role="status"><span className="wd-loading-dot" />Открываем ваш гардероб…</div> : loadError ? <div className="wd-message" role="alert"><h2>Не получилось открыть коллекцию</h2><p>{loadError}</p><button className="wd-secondary" onClick={() => { setLoading(true); setLoadError(''); setRetry(current => current + 1) }}>Попробовать снова</button></div> : <>
        <Activity mode={view === 'collection' ? 'visible' : 'hidden'}><div id="wd-panel-collection" role="tabpanel" aria-labelledby="wd-tab-collection"><CollectionView key={collectionVersion} garments={garments} events={wearEvents} onAdd={() => openEditor()} onOpen={openEditor} onCreateOutfit={createFromSelection} /></div></Activity>
        <Activity mode={view === 'outfits' ? 'visible' : 'hidden'}><div id="wd-panel-outfits" role="tabpanel" aria-labelledby="wd-tab-outfits"><OutfitsView key={outfitSeed?.key ?? 'outfits'} initialGarmentIds={outfitSeed?.ids} garments={garments} outfits={outfits} events={wearEvents} today={today} onSave={saveOutfit} onRemove={removeOutfit} onWear={recordWear} onCollection={() => navigate('collection')} /></div></Activity>
        <Activity mode={view === 'history' ? 'visible' : 'hidden'}><div id="wd-panel-history" role="tabpanel" aria-labelledby="wd-tab-history"><WearHistory garments={garments} outfits={outfits} events={wearEvents} today={today} onWear={recordWear} onRemoveEvent={removeWearEvent} onOutfits={() => navigate('outfits')} /></div></Activity>
        <Activity mode={view === 'wishlist' ? 'visible' : 'hidden'}><div id="wd-panel-wishlist" role="tabpanel" aria-labelledby="wd-tab-wishlist"><WishlistView items={wishlist} garments={garments} onSave={savePurchase} onRemove={removePurchase} onPurchase={item => { setNotice(''); setEditor({ garment: null, purchaseId: item.id }) }} onOpenGarment={garment => { navigate('collection'); openEditor(garment) }} /></div></Activity>
        <Activity mode={view === 'stylist' ? 'visible' : 'hidden'}><div id="wd-panel-stylist" role="tabpanel" aria-labelledby="wd-tab-stylist"><Suspense fallback={<div className="wd-message" role="status">Открываем чат…</div>}><WardrobeChat repository={repository} garments={garments} today={today} onApply={applyAgentAction} onOpenGarment={openEditor} onAddGarment={(action, onSaved) => setEditor({ garment: null, agentAction: action, onAgentSaved: onSaved })} /></Suspense></div></Activity>
      </>}

      {editor ? <GarmentEditor key={editor.garment?.id ?? editor.purchaseId ?? editor.agentAction?.id ?? 'new'} garment={editor.garment} initialDraft={editor.agentAction?.draft ?? (purchase ? { name: purchase.name, category: purchase.category, notes: purchase.notes } : undefined)} initialPhoto={purchase?.photo} title={purchase ? 'Добавить покупку в гардероб' : editor.agentAction ? 'Добавить вещь со стилистом' : undefined} onSave={saveGarment} onRemove={editor.garment ? removeGarment : undefined} onDismiss={() => setEditor(null)} /> : null}
      {notice ? <div className="wd-toast" role="status" aria-live="polite"><span><WardrobeIcon name="check" size={18} /></span><p>{notice}</p><button aria-label="Закрыть уведомление" onClick={() => setNotice('')}><WardrobeIcon name="close" size={16} /></button></div> : null}
    </section>
  )
}
