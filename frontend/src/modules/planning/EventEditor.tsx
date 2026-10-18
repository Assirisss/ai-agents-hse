import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { EventInput, PlanningEvent } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning, type EditorTarget } from './context'
import { addDays, localDate, localTime, repeatOptions, ruleText, sourceLabel, zonedToIso } from './format'

type Form = { title: string; date: string; endDate: string; allDay: boolean; startTime: string; endTime: string; repeat: string; location: string; description: string; calendarId: string; reminder: string }
const reminders = [{ value: 'default', label: 'По умолчанию' }, { value: '-1', label: 'Без напоминания' }, { value: '0', label: 'В момент начала' }, { value: '5', label: 'За 5 минут' }, { value: '10', label: 'За 10 минут' }, { value: '15', label: 'За 15 минут' }, { value: '30', label: 'За 30 минут' }, { value: '60', label: 'За час' }, { value: '1440', label: 'За день' }]

function formOf(event: PlanningEvent, timeZone: string): Form {
  const base = { title: event.title, repeat: event.rrule ?? '', location: event.location, description: event.description, calendarId: event.calendarId ?? '', reminder: event.reminderMinutes === null ? 'default' : String(event.reminderMinutes) }
  if (event.allDay) return { ...base, allDay: true, date: event.start, endDate: addDays(event.end, -1), startTime: '10:00', endTime: '11:00' }
  return { ...base, allDay: false, date: localDate(event.start, timeZone), endDate: localDate(event.end, timeZone), startTime: localTime(event.start, timeZone), endTime: localTime(event.end, timeZone) }
}

export default function EventEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const { settings, calendars, refresh } = usePlanning()
  const dialog = useRef<HTMLDialogElement>(null)
  const timeZone = settings.timeZone
  const [event, setEvent] = useState<PlanningEvent | null>(null)
  const [form, setForm] = useState<Form | null>(target.mode === 'create'
    ? { title: '', date: target.date, endDate: target.date, allDay: false, startTime: '10:00', endTime: '11:00', repeat: '', location: '', description: '', calendarId: settings.defaultCalendarId ?? '', reminder: 'default' }
    : null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const writable = calendars.filter((calendar) => calendar.writable && calendar.enabled)

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (target.mode !== 'edit') return
    let active = true
    planningApi.event(target.eventId).then((value) => { if (active) { setEvent(value); setForm(formOf(value, timeZone)) } }).catch((cause) => active && setError(errorText(cause)))
    return () => { active = false }
  }, [target, timeZone])

  const set = (patch: Partial<Form>) => setForm((current) => current ? { ...current, ...patch } : current)
  const readOnly = Boolean(event?.readOnly)
  // An event already in an external calendar stays there: moving between calendars is not supported yet.
  const linked = Boolean(event?.calendarId)

  function rule(value: Form) {
    if (!value.repeat) return null
    const [year, month, day] = value.date.split('-').map(Number)
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
    if (value.repeat === 'FREQ=WEEKLY') return `FREQ=WEEKLY;BYDAY=${weekday}`
    if (value.repeat === 'FREQ=MONTHLY') return `FREQ=MONTHLY;BYMONTHDAY=${day}`
    return value.repeat
  }

  async function submit(submitEvent: FormEvent) {
    submitEvent.preventDefault()
    if (!form) return
    setBusy(true); setError('')
    try {
      let start: string, end: string
      if (form.allDay) { start = form.date; end = addDays(form.endDate && form.endDate >= form.date ? form.endDate : form.date, 1) }
      else {
        start = zonedToIso(form.date, form.startTime, timeZone)
        end = zonedToIso(form.date, form.endTime, timeZone)
        if (Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(end) + 86400000).toISOString()
      }
      const input: EventInput = {
        title: form.title, allDay: form.allDay, start, end, location: form.location, description: form.description, timeZone,
        reminderMinutes: form.reminder === 'default' ? null : Number(form.reminder),
        ...(event?.recurrenceOf ? {} : { rrule: rule(form) }),
        ...(event && linked ? {} : { calendarId: form.calendarId || null }),
      }
      if (event) await planningApi.updateEvent(event.id, input)
      else await planningApi.createEvent(input)
      refresh(); onClose()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }

  async function remove(single: boolean) {
    if (!event) return
    if (!window.confirm(single ? 'Удалить только это повторение?' : event.rrule ? `Удалить всю серию «${event.title}»?` : `Удалить «${event.title}»?`)) return
    setBusy(true)
    try {
      if (single && target.mode === 'edit' && target.occurrenceStart) await planningApi.skipOccurrence(event.id, target.occurrenceStart)
      else await planningApi.deleteEvent(event.id)
      refresh(); onClose()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }

  const calendar = calendars.find((item) => item.id === (event?.calendarId ?? form?.calendarId))
  return (
    <dialog ref={dialog} className="pl-dialog" onClose={onClose} onCancel={onClose} aria-labelledby="pl-editor-title">
      <form onSubmit={submit}>
        <div className="pl-spread">
          <h2 id="pl-editor-title">{target.mode === 'create' ? 'Новое событие' : readOnly ? 'Событие' : 'Изменить событие'}</h2>
          <button type="button" className="pl-icon-button" aria-label="Закрыть" onClick={() => dialog.current?.close()}>×</button>
        </div>
        {event ? <p className="pl-caption">Источник: {sourceLabel[event.source]}{calendar ? ` · календарь «${calendar.name}»` : ' · только в этом приложении'}{event.rrule ? ` · ${ruleText(event.rrule)}` : ''}</p> : null}
        {readOnly ? <p className="pl-notice">Это событие только для чтения: календарь не даёт прав на запись или это изменённое повторение серии Яндекса. Измените его в исходном календаре — изменения придут при синхронизации.</p> : null}
        {!form ? <p className="pl-empty">{error || 'Загружаем…'}</p> : (
          <fieldset disabled={readOnly || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="pl-stack">
            <label className="pl-field">Название<input required autoFocus value={form.title} maxLength={200} onChange={(change) => set({ title: change.target.value })} /></label>
            <div className="pl-grid-3">
              <label className="pl-field">Дата<input type="date" required value={form.date} onChange={(change) => set({ date: change.target.value, endDate: change.target.value > form.endDate ? change.target.value : form.endDate })} /></label>
              {form.allDay ? <label className="pl-field">По (включительно)<input type="date" value={form.endDate} min={form.date} onChange={(change) => set({ endDate: change.target.value })} /></label> : (
                <>
                  <label className="pl-field">Начало<input type="time" required value={form.startTime} onChange={(change) => set({ startTime: change.target.value })} /></label>
                  <label className="pl-field">Окончание<input type="time" required value={form.endTime} onChange={(change) => set({ endTime: change.target.value })} /></label>
                </>
              )}
            </div>
            <label className="pl-check"><input type="checkbox" checked={form.allDay} onChange={(change) => set({ allDay: change.target.checked })} />Весь день</label>
            <div className="pl-grid-2">
              {event?.recurrenceOf ? <p className="pl-caption">Это отдельное повторение серии: правило задаётся у всей серии.</p> : (
                <label className="pl-field">Повторение<select value={repeatOptions.some((item) => item.value === form.repeat) ? form.repeat : form.repeat ? 'custom' : ''} onChange={(change) => set({ repeat: change.target.value === 'custom' ? form.repeat : change.target.value })}>
                  {repeatOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  {form.repeat && !repeatOptions.some((item) => item.value === form.repeat) ? <option value="custom">{ruleText(form.repeat)}</option> : null}
                </select></label>
              )}
              <label className="pl-field">Напоминание в Telegram<select value={form.reminder} onChange={(change) => set({ reminder: change.target.value })}>{reminders.map((item) => <option key={item.value} value={item.value}>{item.label}{item.value === 'default' ? ` (за ${settings.defaultReminderMinutes} мин)` : ''}</option>)}</select></label>
            </div>
            <div className="pl-grid-2">
              <label className="pl-field">Место<input value={form.location} maxLength={300} onChange={(change) => set({ location: change.target.value })} /></label>
              <label className="pl-field">Календарь
                <select value={form.calendarId} disabled={Boolean(event && linked)} onChange={(change) => set({ calendarId: change.target.value })} title={event && linked ? 'Перенос между внешними календарями пока не поддерживается' : ''}>
                  <option value="">Только в этом приложении</option>
                  {writable.map((item) => <option key={item.id} value={item.id}>{item.provider === 'google' ? 'Google' : 'Яндекс'} · {item.name}</option>)}
                  {calendar && !writable.some((item) => item.id === calendar.id) ? <option value={calendar.id}>{calendar.name}</option> : null}
                </select>
              </label>
            </div>
            <label className="pl-field">Описание<textarea value={form.description} maxLength={4000} onChange={(change) => set({ description: change.target.value })} /></label>
          </fieldset>
        )}
        {error && form ? <p className="pl-notice error" role="alert">{error}</p> : null}
        <div className="pl-spread">
          <div className="pl-row">
            {event && !readOnly && target.mode === 'edit' && target.occurrenceStart && event.rrule ? <button type="button" className="pl-button danger small" onClick={() => remove(true)} disabled={busy}>Удалить это повторение</button> : null}
            {event && !readOnly ? <button type="button" className="pl-button danger small" onClick={() => remove(false)} disabled={busy}>{event.rrule ? 'Удалить серию' : 'Удалить'}</button> : null}
          </div>
          <div className="pl-row">
            <button type="button" className="pl-button secondary" onClick={() => dialog.current?.close()}>{readOnly ? 'Закрыть' : 'Отмена'}</button>
            {!readOnly && form ? <button type="submit" className="pl-button" disabled={busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</button> : null}
          </div>
        </div>
      </form>
    </dialog>
  )
}
