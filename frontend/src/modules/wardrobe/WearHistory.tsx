import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Garment, Outfit, WearEvent } from './types'
import { formatWearDate, garmentWearStats, localDate } from './outfitDomain'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

type Props = {
  garments: Garment[]
  outfits: Outfit[]
  events: WearEvent[]
  today: string
  onWear: (id: string, date: string) => Promise<void>
  onRemoveEvent: (id: string) => Promise<void>
  onOutfits: () => void
}

export default function WearHistory({ garments, outfits, events, today, onWear, onRemoveEvent, onOutfits }: Props) {
  const [outfitId, setOutfitId] = useState('')
  const [date, setDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [period, setPeriod] = useState('all')
  const [query, setQuery] = useState('')
  const from = new Date(`${today}T12:00:00`)
  from.setDate(from.getDate() - (period === '7' ? 6 : 29))
  const periodEvents = period === 'all' ? events : events.filter(event => event.date >= localDate(from) && event.date <= today)
  const search = query.trim().toLocaleLowerCase('ru')
  const visible = periodEvents.filter(event => `${event.outfitName} ${event.garments.map(item => item.name).join(' ')}`.toLocaleLowerCase('ru').includes(search))
  const stats = garmentWearStats(garments, periodEvents)
  const wornDays = new Set(periodEvents.map(event => event.date)).size
  const neverWorn = stats.filter(item => item.days === 0).length
  const selectedOutfit = outfits.some(outfit => outfit.id === outfitId) ? outfitId : ''
  const outfitIds = new Set(outfits.map(outfit => outfit.id))
  const garmentIds = new Set(garments.map(garment => garment.id))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selectedOutfit || busy) return
    setBusy(true)
    setError('')
    try { await onWear(selectedOutfit, date) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось добавить выход.') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await onRemoveEvent(id); setConfirmRemove(null) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отменить отметку.') }
    finally { setBusy(false) }
  }

  return (
    <div className="wd-history-view">
      <div className="wd-section-heading"><div><h2>История и статистика</h2><p>Что вы носите и к чему возвращаетесь.</p></div></div>
      <div className="wd-view-toolbar"><div className="wd-mini-segment" role="group" aria-label="Период статистики">{[{ value: 'all', label: 'Всё время' }, { value: '7', label: '7 дней' }, { value: '30', label: '30 дней' }].map(option => <button key={option.value} className={period === option.value ? 'is-active' : ''} aria-pressed={period === option.value} onClick={() => setPeriod(option.value)}>{option.label}</button>)}</div><label className="wd-search"><WardrobeIcon name="search" size={17} /><input aria-label="Поиск по истории" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти образ или вещь в журнале" /></label></div>
      <div className="wd-wear-summary"><div><strong>{wornDays}</strong><span>дней с отметками</span></div><div><strong>{new Set(periodEvents.map(event => event.combinationKey)).size}</strong><span>сочетаний надето</span></div><div><strong>{neverWorn}</strong><span>вещей без отметок</span></div></div>
      <form className="wd-log-form" onSubmit={submit}><div className="wd-fields"><label>Образ<select value={selectedOutfit} onChange={event => setOutfitId(event.target.value)} required disabled={busy || !outfits.length}><option value="">Выберите образ</option>{outfits.map(outfit => <option key={outfit.id} value={outfit.id}>{outfit.name}</option>)}</select></label></div><div className="wd-fields"><label>Дата выхода<input aria-label="Дата выхода" type="date" max={today} value={date} onChange={event => setDate(event.target.value)} required disabled={busy} /></label></div><button className="wd-secondary" type="submit" disabled={busy || !selectedOutfit}><WardrobeIcon name="plus" size={17} />Добавить отметку</button></form>
      <p className="wd-view-error" role="status" aria-live="polite">{error}</p>
      <div className="wd-history-columns">
        <section className="wd-history-log" aria-labelledby="wd-log-title"><h3 id="wd-log-title">Журнал выходов</h3>{visible.length ? <ol>{visible.map(event => <li key={event.id}>
          <time dateTime={event.date}>{formatWearDate(event.date)}</time><strong>{event.outfitName}{!outfitIds.has(event.outfitId) ? <small>Образ удалён</small> : null}</strong><p>{event.garments.map(item => `${item.name}${!garmentIds.has(item.id) ? ' (удалена)' : ''}`).join(' · ')}</p>
          {confirmRemove === event.id ? <div className="wd-inline-actions wd-history-remove"><span>Убрать отметку?</span><button className="wd-danger-button" disabled={busy} onClick={() => void remove(event.id)}>Да, убрать</button><button disabled={busy} onClick={() => setConfirmRemove(null)}>Оставить</button></div> : <button className="wd-text-button" disabled={busy} onClick={() => setConfirmRemove(event.id)}>Отменить отметку</button>}
        </li>)}</ol> : <div className="wd-history-empty"><WardrobeIcon name="hanger" size={32} /><p>{events.length ? 'По выбранному периоду и запросу записей нет.' : 'История появится после первого «Надел сегодня».'}</p><button className="wd-secondary" onClick={onOutfits}>К образам<WardrobeIcon name="arrow" size={16} /></button></div>}</section>
        <section className="wd-garment-stats" aria-labelledby="wd-garment-stats-title"><h3 id="wd-garment-stats-title">Как часто вы носите вещи</h3><p className="wd-stats-explanation">Дни носки за выбранный период. Поиск фильтрует только журнал.</p>{stats.length ? <ul>{stats.map(({ garment, days, lastDate }) => <li key={garment.id}><span className="wd-stats-photo"><PhotoImage blob={garment.photo.display} alt="" lazy /></span><div><strong>{garment.name}</strong><span>{lastDate ? `Последний раз: ${formatWearDate(lastDate)}` : 'Ещё нет отметок'}</span></div><span className="wd-stats-days"><strong>{days}</strong><small>дней</small></span></li>)}</ul> : <p className="wd-stats-explanation">Добавьте вещи в коллекцию, чтобы следить за их историей.</p>}</section>
      </div>
    </div>
  )
}
