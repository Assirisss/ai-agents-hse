import { useMemo, useState } from 'react'
import type { Garment, WishlistDraft, WishlistItem } from './types'
import { categories, priorities } from './types'
import { formatPrice } from './wishlistDomain'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'
import WishlistEditor from './WishlistEditor'

type Props = {
  items: WishlistItem[]
  garments: Garment[]
  onSave: (draft: WishlistDraft, previous: WishlistItem | null) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onPurchase: (item: WishlistItem) => void
  onOpenGarment: (garment: Garment) => void
}

export default function WishlistView({ items, garments, onSave, onRemove, onPurchase, onOpenGarment }: Props) {
  const [editor, setEditor] = useState<{ item: WishlistItem | null } | null>(null)
  const [filter, setFilter] = useState<'planned' | 'purchased' | 'all'>('planned')
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState('priority')
  const planned = items.filter(item => item.status === 'planned')
  const sums = useMemo(() => {
    const result = new Map<WishlistItem['currency'], number>()
    for (const item of items) if (item.status === 'planned' && item.priceMinor !== null) result.set(item.currency, (result.get(item.currency) ?? 0) + item.priceMinor)
    return result
  }, [items])
  const priorityOrder = { high: 0, normal: 1, low: 2 }
  const search = query.trim().toLocaleLowerCase('ru')
  const visible = items.filter(item => (filter === 'all' || item.status === filter) && `${item.name} ${item.notes}`.toLocaleLowerCase('ru').includes(search)).sort((a, b) => order === 'newest' ? b.createdAt.localeCompare(a.createdAt) : priorityOrder[a.priority] - priorityOrder[b.priority] || b.createdAt.localeCompare(a.createdAt))

  return <div className="wd-wishlist-view">
    <div className="wd-section-heading"><div><h2>Хочу купить</h2><p>Идеи, которые дополнят ваш гардероб.</p></div><button className="wd-primary" onClick={() => setEditor({ item: null })}><WardrobeIcon name="plus" size={17} />Добавить покупку</button></div>
    <div className="wd-shopping-summary"><span className="wd-summary-icon"><WardrobeIcon name="bag" size={23} /></span><div><strong>{planned.length ? `В планах: ${planned.length}` : 'Место для будущих находок'}</strong><span>{sums.size ? [...sums].map(([currency, amount]) => formatPrice(amount, currency)).join(' · ') : 'Сохраните вещь, которая вам понравилась'}</span></div>{planned.some(item => item.priceMinor === null) ? <span className="wd-summary-footnote">Часть цен не указана</span> : null}</div>
    <div className="wd-view-toolbar"><div className="wd-mini-segment" role="group" aria-label="Статус покупок">{([{ value: 'planned', label: 'В планах' }, { value: 'purchased', label: 'Куплено' }, { value: 'all', label: 'Все' }] as const).map(option => <button key={option.value} className={filter === option.value ? 'is-active' : ''} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}</div><label className="wd-search"><WardrobeIcon name="search" size={17} /><input aria-label="Поиск покупок" placeholder="Найти покупку" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="wd-filter"><span className="wd-sr-only">Порядок покупок</span><select value={order} onChange={event => setOrder(event.target.value)}><option value="priority">По приоритету</option><option value="newest">Сначала новые</option></select></label></div>
    {visible.length ? <div className="wd-wishlist-grid">{visible.map(item => {
      const garment = garments.find(garment => garment.id === item.garmentId)
      return <article className="wd-wishlist-card" key={item.id}>
        <button className="wd-wishlist-photo" aria-label={`Изменить покупку: ${item.name}`} onClick={() => setEditor({ item })}>{item.photo ? <PhotoImage blob={item.photo.display} alt={item.name} lazy /> : <span className="wd-wishlist-no-photo"><WardrobeIcon name="bag" size={40} /><span>{categories[item.category]}</span></span>}<span className={`wd-priority-badge ${item.priority === 'high' && item.status === 'planned' ? 'is-high' : ''}`}>{item.status === 'purchased' ? 'Куплено' : priorities[item.priority]}</span></button>
        <div className="wd-wishlist-card-body"><span className="wd-card-eyebrow">{categories[item.category]}</span><h3>{item.name}</h3><p className="wd-price">{item.priceMinor === null ? <span>Цена не указана</span> : formatPrice(item.priceMinor, item.currency)}</p>{item.notes ? <p className="wd-wishlist-notes">{item.notes}</p> : null}
          <div className="wd-wishlist-links">{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">В магазин ↗</a> : null}<button className="wd-text-button" onClick={() => setEditor({ item })}>Изменить</button></div>
          {item.status === 'planned' ? <button className="wd-secondary" onClick={() => onPurchase(item)}><WardrobeIcon name="check" size={16} />Куплено · в гардероб</button> : garment ? <button className="wd-worn-button" onClick={() => onOpenGarment(garment)}><WardrobeIcon name="hanger" size={16} />Открыть в гардеробе<WardrobeIcon name="arrow" size={15} /></button> : <p className="wd-photo-note">Вещь была удалена из гардероба</p>}
        </div>
      </article>
    })}</div> : <div className="wd-message wd-refined-empty"><span className="wd-empty-icon"><WardrobeIcon name="bag" size={30} /></span><h2>{items.length ? 'Здесь пока пусто' : 'Следующая любимая вещь'}</h2><p>{items.length ? 'Попробуйте другой фильтр или поиск.' : 'Добавьте фото, ссылку или просто название. Вернитесь к покупке, когда будете готовы.'}</p>{items.length ? <button className="wd-secondary" onClick={() => { setFilter('all'); setQuery('') }}>Показать всё</button> : <button className="wd-primary" onClick={() => setEditor({ item: null })}><WardrobeIcon name="plus" size={17} />Добавить покупку</button>}</div>}
    {editor ? <WishlistEditor item={editor.item} onSave={async draft => { await onSave(draft, editor.item); if (!editor.item) setFilter('planned'); setQuery(''); setEditor(null) }} onRemove={editor.item ? async () => { await onRemove(editor.item!.id); setEditor(null) } : undefined} onDismiss={() => setEditor(null)} /> : null}
  </div>
}
