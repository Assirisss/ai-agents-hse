import { useState, type FormEvent } from 'react'
import type { PlanningTask, TaskInput, TaskPriority } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import { dueText, localDate, localTime, minutesText, repeatOptions, ruleText, sourceLabel, zonedToIso } from './format'

type Draft = { title: string; date: string; time: string; priority: TaskPriority; duration: string; repeat: string; project: string; notes: string }
const emptyDraft: Draft = { title: '', date: '', time: '', priority: 2, duration: '', repeat: '', project: '', notes: '' }

/** Task form shared by «new task» and inline editing. Weekly and monthly rules take the day from the deadline. */
export function TaskForm({ task, onDone, onCancel }: { task?: PlanningTask; onDone: () => void; onCancel?: () => void }) {
  const { settings, refresh } = usePlanning()
  const timeZone = settings.timeZone
  const initial: Draft = task ? {
    title: task.title, date: task.due ? (task.dueHasTime ? localDate(task.due, timeZone) : task.due) : '', time: task.due && task.dueHasTime ? localTime(task.due, timeZone) : '',
    priority: task.priority, duration: task.durationMinutes ? String(task.durationMinutes) : '', repeat: task.rrule ?? '', project: task.project, notes: task.notes,
  } : emptyDraft
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Draft>) => setValue((current) => ({ ...current, ...patch }))

  function rule() {
    if (!value.repeat || !value.date) return value.repeat || null
    const [year, month, day] = value.date.split('-').map(Number)
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
    if (value.repeat === 'FREQ=WEEKLY') return `FREQ=WEEKLY;BYDAY=${weekday}`
    if (value.repeat === 'FREQ=MONTHLY') return `FREQ=MONTHLY;BYMONTHDAY=${day}`
    return value.repeat
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    const input: TaskInput = {
      title: value.title, notes: value.notes, project: value.project, priority: value.priority,
      due: value.date ? (value.time ? zonedToIso(value.date, value.time, timeZone) : value.date) : null,
      durationMinutes: value.duration ? Number(value.duration) : null, rrule: rule(),
    }
    try {
      if (task) await planningApi.updateTask(task.id, input)
      else await planningApi.createTask(input)
      if (!task) setValue(emptyDraft)
      refresh(); onDone()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }

  return (
    <form className="pl-stack" onSubmit={submit}>
      <div className="pl-grid-2">
        <label className="pl-field">Название<input required value={value.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} placeholder="Например, подать декларацию" /></label>
        <label className="pl-field">Проект<input value={value.project} maxLength={80} onChange={(event) => set({ project: event.target.value })} placeholder="Необязательно" /></label>
      </div>
      <div className="pl-grid-4">
        <label className="pl-field">Срок<input type="date" value={value.date} onChange={(event) => set({ date: event.target.value })} /></label>
        <label className="pl-field">Время<input type="time" value={value.time} disabled={!value.date} onChange={(event) => set({ time: event.target.value })} /></label>
        <label className="pl-field">Приоритет<select value={value.priority} onChange={(event) => set({ priority: Number(event.target.value) as TaskPriority })}><option value={1}>Высокий</option><option value={2}>Обычный</option><option value={3}>Низкий</option></select></label>
        <label className="pl-field">Займёт, мин<input type="number" min={5} max={1440} step={5} value={value.duration} onChange={(event) => set({ duration: event.target.value })} placeholder="—" /></label>
      </div>
      <div className="pl-grid-2">
        <label className="pl-field">Повторение<select value={repeatOptions.some((item) => item.value === value.repeat) ? value.repeat : value.repeat ? 'custom' : ''} onChange={(event) => set({ repeat: event.target.value === 'custom' ? value.repeat : event.target.value })}>
          {repeatOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          {value.repeat && !repeatOptions.some((item) => item.value === value.repeat) ? <option value="custom">{ruleText(value.repeat)}</option> : null}
        </select></label>
        <label className="pl-field">Заметки<input value={value.notes} maxLength={4000} onChange={(event) => set({ notes: event.target.value })} /></label>
      </div>
      {value.repeat && !value.date ? <p className="pl-caption">Для повторяющегося обязательства укажите первый срок — после выполнения появится следующее.</p> : null}
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      <div className="pl-form-actions">
        {onCancel ? <button type="button" className="pl-button secondary" onClick={onCancel}>Отмена</button> : null}
        <button type="submit" className="pl-button" disabled={busy}>{task ? 'Сохранить' : 'Добавить задачу'}</button>
      </div>
    </form>
  )
}

export default function TaskRow({ task }: { task: PlanningTask }) {
  const { settings, today, now, refresh } = usePlanning()
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const timeZone = settings.timeZone
  const overdue = task.status === 'open' && Boolean(task.due) && (task.dueHasTime ? Date.parse(task.due!) < now : task.due! < today)

  async function toggle() {
    try {
      if (task.status === 'open') {
        const result = await planningApi.completeTask(task.id)
        if (result.next) setMessage(`Следующий срок: ${dueText(result.next.due, result.next.dueHasTime, timeZone, today)}`)
      } else await planningApi.updateTask(task.id, { status: 'open' })
      refresh()
    } catch (cause) { setMessage(errorText(cause)) }
  }
  async function remove() {
    if (!window.confirm(`Удалить задачу «${task.title}»?`)) return
    try { await planningApi.deleteTask(task.id); refresh() } catch (cause) { setMessage(errorText(cause)) }
  }

  return (
    <li className={`pl-task${task.status === 'done' ? ' done' : ''}`}>
      <button type="button" className="pl-task-check" aria-label={task.status === 'open' ? `Выполнено: ${task.title}` : `Вернуть в работу: ${task.title}`} onClick={toggle}>✓</button>
      <div>
        <button type="button" className="pl-task-title" onClick={() => setEditing(!editing)} aria-expanded={editing}>{task.title}</button>
        <div className="pl-task-meta">
          <span className={`pl-caption${overdue ? ' overdue' : ''}`}>{overdue ? 'просрочено · ' : ''}{dueText(task.due, task.dueHasTime, timeZone, today)}</span>
          {task.priority === 1 ? <span className="pl-badge red">важно</span> : null}
          {task.rrule ? <span className="pl-badge accent">↻ {ruleText(task.rrule)}</span> : null}
          {task.durationMinutes ? <span className="pl-badge">{minutesText(task.durationMinutes)}</span> : null}
          {task.project ? <span className="pl-badge">{task.project}</span> : null}
          {task.source === 'ai' || task.source === 'parser' ? <span className="pl-caption">· {sourceLabel[task.source]}</span> : null}
        </div>
        {message ? <p className="pl-caption" style={{ marginTop: 4 }}>{message}</p> : null}
        {editing ? <div className="pl-card pl-form-card"><TaskForm task={task} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} /></div> : null}
      </div>
      <button type="button" className="pl-icon-button" aria-label={`Удалить «${task.title}»`} onClick={remove}>×</button>
    </li>
  )
}
