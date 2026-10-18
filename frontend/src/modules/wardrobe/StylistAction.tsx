import type { WardrobeAction } from '../../../../shared/wardrobe-agent'
import type { Garment } from './types'
import { categories, colors, seasons } from './types'
import { arrangeOutfitLayers, formatWearDate } from './outfitDomain'
import { formatPrice } from './wishlistDomain'
import OutfitBoard from './OutfitBoard'
import WardrobeIcon from './WardrobeIcon'

export default function StylistAction({ action, garments, result, busy, disabled, error, onApply, onDismiss }: {
  action: WardrobeAction; garments: Garment[]; result?: { status: 'applied' | 'dismissed'; message: string }
  busy: boolean; disabled: boolean; error?: string; onApply: () => void; onDismiss: () => void
}) {
  const title = action.kind === 'outfit' ? action.name : action.kind === 'wear' ? action.outfitName : action.draft.name
  const label = { outfit: 'Новый образ', purchase: 'В список желаний', garment: 'Новая вещь', update: 'Изменение вещи', wear: 'Отметка носки' }[action.kind]
  const button = { outfit: 'Сохранить образ', purchase: 'Добавить в желания', garment: 'Добавить фото и сохранить', update: 'Применить изменения', wear: 'Отметить выход' }[action.kind]
  const missing = action.kind === 'outfit' && action.garmentIds.some(id => !garments.some(item => item.id === id))
  const previous = action.kind === 'update' ? garments.find(item => item.id === action.garmentId) : undefined
  return <article className={`wd-stylist-action ${result ? 'is-resolved' : ''}`} aria-label={`${label}: ${title}`}>
    {action.kind === 'outfit' ? <div className="wd-stylist-outfit"><OutfitBoard layers={arrangeOutfitLayers(action.garmentIds, garments)} garments={garments} /><div className="wd-stylist-outfit-items">{action.garmentIds.map(id => <span key={id}>{garments.find(item => item.id === id)?.name ?? 'Вещь недоступна'}</span>)}</div></div> : null}
    <div className="wd-stylist-action-body"><p className="wd-stylist-action-kind">{label}</p><h3>{title}</h3><p>{action.reason}</p>
      {action.kind === 'wear' ? <p className="wd-stylist-action-detail">{formatWearDate(action.date)}</p> : null}
      {action.kind === 'purchase' ? <p className="wd-stylist-action-detail">{categories[action.draft.category]} · {action.draft.priceMinor === null ? 'Цена не указана' : formatPrice(action.draft.priceMinor, action.draft.currency)}</p> : null}
      {action.kind === 'garment' ? <p className="wd-stylist-action-detail">{categories[action.draft.category]} · {colors[action.draft.color].label} · {seasons[action.draft.season]}</p> : null}
      {action.kind === 'update' ? <dl className="wd-stylist-changes">{([
        ['name', 'Название', action.draft.name, previous?.name], ['category', 'Категория', categories[action.draft.category], previous ? categories[previous.category] : undefined],
        ['color', 'Цвет', colors[action.draft.color].label, previous ? colors[previous.color].label : undefined], ['season', 'Сезон', seasons[action.draft.season], previous ? seasons[previous.season] : undefined],
        ['brand', 'Бренд', action.draft.brand, previous?.brand], ['notes', 'Заметка', action.draft.notes, previous?.notes],
      ] as const).filter(([, , value, old]) => value !== old).map(([key, name, value, old]) => <div key={key}><dt>{name}</dt><dd>{old ? <><del>{old}</del><span aria-hidden="true"> → </span></> : null}{value || 'Не указано'}</dd></div>)}</dl> : null}
      {result ? <p className="wd-stylist-action-result" role="status"><WardrobeIcon name={result.status === 'applied' ? 'check' : 'close'} size={16} />{result.message}</p> : <><div className="wd-stylist-action-buttons"><button className="wd-primary" disabled={disabled || !!missing} onClick={onApply}>{busy ? 'Применяем…' : button}</button><button className="wd-text-button" disabled={disabled} onClick={onDismiss}>Пропустить</button></div>{missing ? <p className="wd-view-error">Одна из вещей удалена. Попросите стилиста обновить образ.</p> : null}</>}
      {error ? <p className="wd-view-error" role="alert">{error}</p> : null}
    </div>
  </article>
}
