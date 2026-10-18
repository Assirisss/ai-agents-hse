import { useState, type ReactNode } from 'react'
import type { DraftItem, PlanningDraft } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import { addDays, localDate, localTime, range, ruleText, zonedToIso } from './format'

const isDate = (value?: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
const methodLabel = { parser: 'правила', ai: 'модель + правила для дат', 'parser+ai': 'правила и модель', agent: 'агент, время проверено кодом' }

type Fields = { date: string; startTime: string; endTime: string; allDay: boolean }

function fieldsOf(item: DraftItem, timeZone: string): Fields {
  if (item.kind === 'task') {
    if (!item.due) return { date: '', startTime: '', endTime: '', allDay: false }
    return isDate(item.due) ? { date: item.due, startTime: '', endTime: '', allDay: false } : { date: localDate(item.due, timeZone), startTime: localTime(item.due, timeZone), endTime: '', allDay: false }
  }
  if (!item.start) return { date: '', startTime: '', endTime: '', allDay: false }
  if (item.allDay || isDate(item.start)) return { date: item.start, startTime: '', endTime: '', allDay: Boolean(item.allDay) }
  return { date: localDate(item.start, timeZone), startTime: localTime(item.start, timeZone), endTime: item.end ? localTime(item.end, timeZone) : '', allDay: false }
}

/** Rebuild an item from form fields; required values that are still empty go to `missing`. */
function withFields(item: DraftItem, fields: Fields, timeZone: string): DraftItem {
  if (item.kind === 'task') {
    const due = fields.date ? (fields.startTime ? zonedToIso(fields.date, fields.startTime, timeZone) : fields.date) : null
    return { ...item, due, dueHasTime: Boolean(fields.date && fields.startTime), missing: [] }
  }
  if (!fields.date) return { ...item, start: undefined, end: undefined, missing: ['дата'] }
  if (fields.allDay) return { ...item, allDay: true, start: fields.date, end: addDays(fields.date, 1), missing: [] }
  if (!fields.startTime) return { ...item, allDay: false, start: fields.date, end: undefined, missing: ['время'] }
  const start = zonedToIso(fields.date, fields.startTime, timeZone)
  let end = fields.endTime ? zonedToIso(fields.date, fields.endTime, timeZone) : new Date(Date.parse(start) + (item.durationMinutes || 60) * 60000).toISOString()
  if (Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(end) + 86400000).toISOString()
  return { ...item, allDay: false, start, end, missing: [] }
}

function switchKind(item: DraftItem, kind: DraftItem['kind'], timeZone: string): DraftItem {
  const fields = fieldsOf(item, timeZone)
  return withFields({ ...item, kind, conflicts: kind === 'task' ? [] : item.conflicts }, fields, timeZone)
}

/** Editable draft from rules, the model or the agent. Nothing is stored until «Сохранить». */
export default function DraftPanel({ draft, onSaved, onCancelled, action }: { draft: PlanningDraft; onSaved: (message: string) => void; onCancelled: () => void; action?: ReactNode }) {
  const { settings, calendars, refresh } = usePlanning()
  const [items, setItems] = useState<DraftItem[]>(draft.items)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timeZone = settings.timeZone

  async function save() {
    setBusy(true); setError('')
    try {
      const result = await planningApi.confirmDraft(draft.id, items)
      refresh()
      onSaved(`Сохранено: ${[result.created.events.length && `${result.created.events.length} соб.`, result.created.tasks.length && `${result.created.tasks.length} зад.`].filter(Boolean).join(', ')}`)
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function cancel() {
    await planningApi.cancelDraft(draft.id).catch(() => undefined)
    onCancelled()
  }

  const update = (index: number, next: DraftItem) => setItems((values) => values.map((value, position) => position === index ? next : value))
  const incomplete = items.some((item) => item.missing.length || !item.title.trim())

  return (
    <div className="pl-draft" aria-live="polite">
      <div className="pl-spread">
        <div className="pl-row"><strong>Черновик</strong><span className={`pl-badge ${draft.method === 'parser' ? 'green' : 'accent'}`}>{methodLabel[draft.method]}</span>{action}</div>
        <span className="pl-caption">Проверьте поля — без подтверждения ничего не сохраняется</span>
      </div>
      {items.some((item) => item.kind === 'event') ? (() => {
        const target = calendars.find((calendar) => calendar.id === settings.defaultCalendarId)
        return <p className="pl-caption" style={{ marginTop: 6 }}>События сохранятся {target ? `в ${target.provider === 'google' ? 'Google' : 'Яндекс'} · «${target.name}»` : 'только в этом приложении — календарь для новых событий выбирается на вкладке «Подключения»'}. Задачи хранятся здесь.</p>
      })() : null}
      {draft.question ? <p className="pl-notice warning">❓ {draft.question}</p> : null}
      {items.map((item, index) => {
        const fields = fieldsOf(item, timeZone)
        const setFields = (patch: Partial<Fields>) => update(index, withFields(item, { ...fields, ...patch }, timeZone))
        return (
          <div className={`pl-draft-item${item.missing.length ? ' incomplete' : ''}`} key={index}>
            <div className="pl-spread">
              <div className="pl-kind" role="group" aria-label="Тип записи">
                <button type="button" aria-pressed={item.kind === 'event'} onClick={() => update(index, switchKind(item, 'event', timeZone))}>Событие</button>
                <button type="button" aria-pressed={item.kind === 'task'} onClick={() => update(index, switchKind(item, 'task', timeZone))}>Задача</button>
              </div>
              <div className="pl-row">
                {item.rrule ? <span className="pl-badge accent">↻ {ruleText(item.rrule)} <button type="button" aria-label="Убрать повторение" onClick={() => update(index, { ...item, rrule: null })}>×</button></span> : null}
                {item.kind === 'event' && item.start && item.end ? <span className="pl-caption">{range(item.start, item.end, Boolean(item.allDay), timeZone)}</span> : null}
                {items.length > 1 ? <button type="button" className="pl-icon-button" aria-label="Убрать из черновика" onClick={() => setItems((values) => values.filter((_, position) => position !== index))}>×</button> : null}
              </div>
            </div>
            <div className="pl-draft-fields">
              <label className="pl-field">Название<input value={item.title} onChange={(event) => update(index, { ...item, title: event.target.value })} /></label>
              <label className="pl-field">{item.kind === 'task' ? 'Срок' : 'Дата'}<input type="date" value={fields.date} onChange={(event) => setFields({ date: event.target.value })} /></label>
              {item.kind === 'event' && fields.allDay ? <label className="pl-check"><input type="checkbox" checked onChange={() => setFields({ allDay: false })} />Весь день</label> : (
                <>
                  <label className="pl-field">{item.kind === 'task' ? 'Время (необязательно)' : 'Начало'}<input type="time" value={fields.startTime} onChange={(event) => setFields({ startTime: event.target.value })} /></label>
                  {item.kind === 'event' ? <label className="pl-field">Окончание<input type="time" value={fields.endTime} onChange={(event) => setFields({ endTime: event.target.value })} /></label> : <span />}
                </>
              )}
            </div>
            {item.kind === 'event' && !fields.allDay ? <label className="pl-check" style={{ marginTop: 8 }}><input type="checkbox" checked={false} onChange={() => setFields({ allDay: true })} />Весь день</label> : null}
            {item.missing.length ? <p className="pl-caption" style={{ color: 'var(--orange)', marginTop: 8 }}>Не хватает: {item.missing.join(', ')}</p> : null}
            {item.conflicts.length ? <p className="pl-caption" style={{ color: 'var(--orange)', marginTop: 8 }}>⚠ Пересекается: {item.conflicts.map((conflict) => `${conflict.allDay ? '' : `${localTime(conflict.start, timeZone)} `}${conflict.title}`).join(', ')}</p> : null}
            {item.assumptions.length ? <ul>{item.assumptions.map((value) => <li key={value}>{value}</li>)}</ul> : null}
          </div>
        )
      })}
      {draft.notes.length ? <details className="pl-details"><summary>Как разобрано</summary><ul className="pl-steps">{draft.notes.map((note) => <li key={note}>{note}</li>)}</ul></details> : null}
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      <div className="pl-form-actions">
        <button type="button" className="pl-button secondary" onClick={cancel} disabled={busy}>Отмена</button>
        <button type="button" className="pl-button" onClick={save} disabled={busy || incomplete || !items.length}>{busy ? 'Сохраняю…' : `Сохранить${items.length > 1 ? ` (${items.length})` : ''}`}</button>
      </div>
    </div>
  )
}
