import { useMemo, useState } from 'react'
import { categories, colors, seasons } from './types'
import type { Category, Garment, WearEvent } from './types'
import { garmentWearStats, MAX_OUTFIT_ITEMS } from './outfitDomain'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

type Props = { garments: Garment[]; events: WearEvent[]; onAdd: () => void; onOpen: (garment: Garment) => void; onCreateOutfit: (ids: string[]) => void }

export default function CollectionView({ garments, events, onAdd, onOpen, onCreateOutfit }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [season, setSeason] = useState('all')
  const [color, setColor] = useState('all')
  const [order, setOrder] = useState('newest')
  const [neverWorn, setNeverWorn] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const stats = useMemo(() => new Map(garmentWearStats(garments, events).map(stat => [stat.garment.id, stat])), [garments, events])
  const ids = new Set(garments.map(garment => garment.id))
  const validSelection = selected.filter(id => ids.has(id))
  const search = query.trim().toLocaleLowerCase('ru')
  const visible = garments.filter(item =>
    (category === 'all' || item.category === category) &&
    (season === 'all' || item.season === 'all' || item.season === season) &&
    (color === 'all' || item.color === color) &&
    (!neverWorn || !stats.get(item.id)?.days) &&
    (!search || `${item.name} ${item.brand} ${item.notes} ${categories[item.category]} ${colors[item.color].label}`.toLocaleLowerCase('ru').includes(search)),
  ).sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'ru') : order === 'most-worn' ? (stats.get(b.id)?.days ?? 0) - (stats.get(a.id)?.days ?? 0) : order === 'least-worn' ? (stats.get(a.id)?.days ?? 0) - (stats.get(b.id)?.days ?? 0) : b.createdAt.localeCompare(a.createdAt))
  const filterCount = Number(season !== 'all') + Number(color !== 'all') + Number(neverWorn)
  const hasFilters = !!search || category !== 'all' || filterCount > 0

  function reset() { setQuery(''); setCategory('all'); setSeason('all'); setColor('all'); setNeverWorn(false) }
  function toggle(garment: Garment) {
    if (!selecting) { onOpen(garment); return }
    setMessage('')
    if (validSelection.includes(garment.id)) setSelected(validSelection.filter(id => id !== garment.id))
    else if (validSelection.length < MAX_OUTFIT_ITEMS) setSelected([...validSelection, garment.id])
    else setMessage(`В один образ можно добавить до ${MAX_OUTFIT_ITEMS} вещей.`)
  }

  return <div className="wd-collection-view">
    <div className="wd-section-heading"><div><h2>Моя коллекция <span className="wd-heading-count">{garments.length}</span></h2><p>Всё, что нравится носить.</p></div><button className={selecting ? 'wd-secondary is-selected' : 'wd-secondary'} aria-pressed={selecting} disabled={!garments.length} onClick={() => { setSelecting(!selecting); setSelected([]); setMessage('') }}><WardrobeIcon name="select" size={17} />{selecting ? 'Готово' : 'Выбрать вещи'}</button></div>
    <div className="wd-view-toolbar"><label className="wd-search"><WardrobeIcon name="search" size={18} /><input aria-label="Поиск вещей" value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по вещам, брендам и заметкам" /></label><button className={`wd-filter-toggle ${filterCount ? 'is-selected' : ''}`} aria-expanded={filtersOpen} aria-controls="wd-collection-filters" onClick={() => setFiltersOpen(!filtersOpen)}><WardrobeIcon name="sliders" size={17} />Фильтры{filterCount ? <span>{filterCount}</span> : null}</button><label className="wd-filter wd-sort"><span className="wd-sr-only">Порядок вещей</span><select value={order} onChange={event => setOrder(event.target.value)}><option value="newest">Сначала новые</option><option value="name">По названию</option><option value="most-worn">Чаще ношу</option><option value="least-worn">Реже ношу</option></select></label><button className="wd-icon-button wd-density" aria-label="Компактные карточки" aria-pressed={compact} onClick={() => setCompact(!compact)}><WardrobeIcon name="grid" size={18} /></button></div>
    {filtersOpen ? <div className="wd-filter-panel" id="wd-collection-filters"><label className="wd-filter"><span>Сезон</span><select value={season} onChange={event => setSeason(event.target.value)}><option value="all">Все сезоны</option>{Object.entries(seasons).filter(([value]) => value !== 'all').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wd-filter"><span>Цвет</span><select value={color} onChange={event => setColor(event.target.value)}><option value="all">Все цвета</option>{Object.entries(colors).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={neverWorn ? 'wd-secondary is-selected' : 'wd-secondary'} aria-pressed={neverWorn} onClick={() => setNeverWorn(!neverWorn)}>Пока не носил</button>{hasFilters ? <button className="wd-text-button" onClick={reset}>Сбросить всё</button> : null}</div> : null}
    <div className="wd-categories" role="group" aria-label="Категория вещи"><button className={category === 'all' ? 'is-active' : ''} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>Все вещи</button>{Object.entries(categories).map(([value, label]) => <button key={value} className={category === value ? 'is-active' : ''} aria-pressed={category === value} onClick={() => setCategory(value as Category)}>{label}</button>)}</div>
    <p className="wd-view-error" role="status">{message}</p>
    {!garments.length ? <div className="wd-collection-welcome"><div className="wd-welcome-art" aria-hidden="true"><span><WardrobeIcon name="hanger" size={70} /></span><span><WardrobeIcon name="layers" size={62} /></span><span><WardrobeIcon name="bag" size={56} /></span></div><p className="wd-kicker">НАЧНИТЕ С ЛЮБИМОЙ ВЕЩИ</p><h2>Больше порядка.<br /><span>Больше сочетаний.</span></h2><p>Добавьте фото и несколько деталей.<br />Остальное сложится в ваш гардероб.</p><button className="wd-primary" onClick={onAdd}><WardrobeIcon name="plus" size={18} />Добавить первую вещь</button></div> : !visible.length ? <div className="wd-message wd-refined-empty"><span className="wd-empty-icon"><WardrobeIcon name="search" size={30} /></span><h2>Ничего не нашлось</h2><p>Измените запрос или попробуйте другие фильтры.</p><button className="wd-secondary" onClick={reset}>Сбросить фильтры</button></div> : <>
      <div className="wd-results"><span>{hasFilters ? `Найдено ${visible.length} из ${garments.length}` : 'Ваша личная коллекция'}</span>{hasFilters ? <button onClick={reset}>Сбросить фильтры</button> : <span>{selecting ? 'Выберите вещи для нового образа' : 'Нажмите на вещь, чтобы открыть детали'}</span>}</div>
      <div className={`wd-garment-grid ${compact ? 'is-compact' : ''}`}>{visible.map(garment => {
        const selected = validSelection.includes(garment.id)
        const days = stats.get(garment.id)?.days ?? 0
        return <button className={`wd-garment ${selecting ? 'is-selectable' : ''} ${selecting && selected ? 'is-selected' : ''}`} key={garment.id} aria-label={selecting ? `Выбрать: ${garment.name}` : `Открыть: ${garment.name}`} aria-pressed={selecting ? selected : undefined} onClick={() => toggle(garment)}>
          <div className="wd-garment-photo"><PhotoImage blob={garment.photo.display} alt={garment.name} lazy />{selecting ? <span className="wd-selection-check">{selected ? <WardrobeIcon name="check" size={16} /> : null}</span> : <span className="wd-garment-open"><WardrobeIcon name="arrow" size={18} /></span>}</div>
          <div className="wd-garment-info"><div className="wd-garment-meta"><span>{categories[garment.category]}</span><span className="wd-color-dot" style={{ background: colors[garment.color].value ?? '#b19a83' }} title={colors[garment.color].label} /></div><h3>{garment.name}</h3><p>{garment.brand || colors[garment.color].label}</p><span className={`wd-wear-pill ${days ? 'has-wears' : ''}`}>{days ? `Дней носки: ${days}` : 'Пока без выходов'}</span></div>
        </button>
      })}<button className="wd-add-card" onClick={onAdd}><span><WardrobeIcon name="plus" size={24} /></span>Добавить вещь</button></div>
    </>}
    {selecting ? <div className="wd-selection-bar"><div><WardrobeIcon name="select" size={20} /><span>Выбрано <strong>{validSelection.length}</strong> из {MAX_OUTFIT_ITEMS}</span></div><div><button className="wd-text-button" onClick={() => { setSelecting(false); setSelected([]) }}>Отмена</button><button className="wd-primary" disabled={!validSelection.length} onClick={() => { onCreateOutfit(validSelection); setSelecting(false); setSelected([]) }}><WardrobeIcon name="layers" size={17} />Собрать образ</button></div></div> : null}
  </div>
}
