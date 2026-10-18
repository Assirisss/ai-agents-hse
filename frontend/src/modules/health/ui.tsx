import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Nutrients } from '../../../../shared/health'
import { labels, nutrientKeys, fmt, errorMessage } from './format'

export function Icon({ name, size = 20 }: { name: 'activity' | 'food' | 'chart' | 'sparkles' | 'sun' | 'plus' | 'arrow'; size?: number }) {
  const paths = { activity: <><path d="m5 7 12 10M3 9l4-5m10 16 4-5M8 3l1 1M15 20l1 1M2 7l1 1m18 8 1 1" /></>, food: <><path d="M4 3v6a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-5 2-5 10 0 10" /></>, chart: <><path d="M4 3v17h17M8 15l4-5 4 2 5-7" /></>, sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" /></>, sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>, plus: <path d="M12 5v14M5 12h14" />, arrow: <path d="m9 5 7 7-7 7" /> }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="sp-empty"><span className="sp-empty-icon"><Icon name="activity" size={28} /></span><h3>{title}</h3><p>{children}</p>{action}</div>
}
export function NutritionCards({ value, goals }: { value: Nutrients; goals?: { [K in keyof Nutrients]: number | null } }) {
  return <div className="sp-nutrients">{nutrientKeys.map(key => <div className="sp-nutrient" key={key}><span>{labels[key]}</span><strong>{fmt(value[key], key === 'calories' ? 0 : 1)} <small>{key === 'calories' ? 'ккал' : 'г'}</small></strong>{goals?.[key] ? <><progress value={value[key]} max={goals[key]!} aria-label={labels[key]} /><small>из {fmt(goals[key]!)} {key === 'calories' ? 'ккал' : 'г'}{value[key] > goals[key]! ? ' · выше цели' : ''}</small></> : <small>Цель не задана</small>}</div>)}</div>
}
export function EditorDialog({ title, children, onClose, onSave, onDelete, wide = false }: { title: string; children: ReactNode; onClose: () => void; onSave: () => Promise<void>; onDelete?: () => Promise<void>; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  async function execute(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  function submit(event: FormEvent) { event.preventDefault(); void execute(onSave) }
  return <dialog ref={ref} className={`sp-dialog${wide ? ' sp-dialog-wide' : ''}`} aria-labelledby="sp-editor-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={submit}><header><div><p className="sp-kicker">Спорт и питание</p><h2 id="sp-editor-title">{title}</h2></div><button type="button" className="sp-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button></header>
      <fieldset disabled={busy} className="sp-form-body">{children}</fieldset>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {confirm && <div className="sp-delete-confirm"><p>Удалить запись? Это действие нельзя отменить.</p><button type="button" className="sp-danger" disabled={busy} onClick={() => onDelete && void execute(onDelete)}>Да, удалить</button><button type="button" className="sp-secondary" disabled={busy} onClick={() => setConfirm(false)}>Оставить</button></div>}
      <footer>{onDelete && <button type="button" className="sp-danger" disabled={busy} onClick={() => setConfirm(true)}>Удалить</button>}<span /><button type="button" className="sp-secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="sp-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></footer>
    </form>
  </dialog>
}
