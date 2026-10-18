import { useEffect, useState } from 'react'
import type { DayBrief, Occurrence } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import { addDays, localTime, minutesText, relativeDay } from './format'
import TaskRow from './TaskRow'

export function OccurrenceButton({ item, conflict = false }: { item: Occurrence; conflict?: boolean }) {
  const { settings, openEditor, calendars } = usePlanning()
  const calendar = calendars.find((value) => value.id === item.calendarId)
  return (
    <button type="button" className={`pl-occurrence ${item.source === 'google' || item.source === 'yandex' ? item.source : ''}${conflict ? ' conflict' : ''}`}
      onClick={() => openEditor({ mode: 'edit', eventId: item.eventId, occurrenceStart: item.recurring ? item.start : undefined })}>
      <span className="time">{item.allDay ? 'весь день' : `${localTime(item.start, settings.timeZone)}–${localTime(item.end, settings.timeZone)}`}</span>
      <span className="title">{item.recurring ? '↻ ' : ''}{item.title}</span>
      <span className="meta">{[item.location, calendar?.name].filter(Boolean).join(' · ')}</span>
    </button>
  )
}

export default function TodayView() {
  const { today, revision, settings, openEditor } = usePlanning()
  const [date, setDate] = useState(today)
  const [brief, setBrief] = useState<DayBrief | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    planningApi.brief(date, controller.signal).then((value) => { setBrief(value); setError('') }).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [date, revision, settings.timeZone, settings.workStart, settings.workEnd])

  const conflicted = new Set(brief?.conflicts.flatMap((item) => [`${item.first.eventId}|${item.first.start}`, `${item.second.eventId}|${item.second.start}`]))
  return (
    <section className="pl-section" aria-labelledby="pl-day-title">
      <div className="pl-spread">
        <div className="pl-daynav">
          <h2 id="pl-day-title">{relativeDay(date, today)}{date === today || date === addDays(today, 1) ? <span className="pl-caption"> · {new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</span> : null}</h2>
          <button type="button" className="pl-icon-button" aria-label="Предыдущий день" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <button type="button" className="pl-button secondary small" onClick={() => setDate(today)} disabled={date === today}>Сегодня</button>
          <button type="button" className="pl-icon-button" aria-label="Следующий день" onClick={() => setDate(addDays(date, 1))}>›</button>
          <input className="pl-input" style={{ width: 150, height: 30 }} type="date" value={date} aria-label="Выбрать дату" onChange={(event) => event.target.value && setDate(event.target.value)} />
        </div>
        <button type="button" className="pl-button secondary" onClick={() => openEditor({ mode: 'create', date })}>＋ Событие</button>
      </div>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      {brief ? (
        <>
          <div className="pl-stats">
            <div><span className="pl-stat">{brief.events.length + brief.allDay.length}</span><span>событий</span></div>
            <div><span className="pl-stat">{brief.tasksDue.length}</span><span>задач со сроком</span></div>
            <div><span className="pl-stat">{minutesText(brief.busyMinutes)}</span><span>занято в рабочие часы</span></div>
            <div><span className="pl-stat">{minutesText(brief.freeMinutes)}</span><span>свободно {settings.workStart}–{settings.workEnd}</span></div>
            {brief.overdue.length ? <div><span className="pl-stat" style={{ color: 'var(--red)' }}>{brief.overdue.length}</span><span>просрочено</span></div> : null}
          </div>
          {brief.conflicts.map((item) => <p className="pl-notice warning" key={`${item.first.eventId}${item.second.eventId}${item.first.start}`}>⚠ Пересечение {minutesText(item.overlapMinutes)}: «{item.first.title}» и «{item.second.title}»</p>)}
          {brief.overload ? <p className="pl-notice warning">⚠ Задачам с оценкой длительности нужно {minutesText(brief.plannedTaskMinutes)}, а свободно {minutesText(brief.freeMinutes)} — часть стоит перенести.</p> : null}
          <div className="pl-today" style={{ marginTop: 16 }}>
            <div className="pl-card">
              <h3>События</h3>
              {!brief.events.length && !brief.allDay.length ? <p className="pl-empty">Событий нет. Добавьте через поле выше или кнопку «＋ Событие».</p> : (
                <ul className="pl-timeline">
                  {[...brief.allDay, ...brief.events].map((item) => <li key={`${item.eventId}|${item.start}`}><OccurrenceButton item={item} conflict={conflicted.has(`${item.eventId}|${item.start}`)} /></li>)}
                </ul>
              )}
              <h3 style={{ marginTop: 22 }}>Свободные окна</h3>
              {brief.freeSlots.length ? <div className="pl-slots">{brief.freeSlots.map((slot) => <span className="pl-slot" key={slot.start}>{localTime(slot.start, settings.timeZone)}–{localTime(slot.end, settings.timeZone)} · {minutesText(slot.minutes)}</span>)}</div> : <p className="pl-empty">В рабочие часы свободного времени нет.</p>}
            </div>
            <div className="pl-card">
              <h3>Задачи на день</h3>
              {brief.tasksDue.length ? <ul className="pl-task-list">{brief.tasksDue.map((task) => <TaskRow key={task.id} task={task} />)}</ul> : <p className="pl-empty">Задач со сроком на этот день нет.</p>}
              {brief.overdue.length ? <><h3 style={{ marginTop: 22, color: 'var(--red)' }}>Просрочено</h3><ul className="pl-task-list">{brief.overdue.map((task) => <TaskRow key={task.id} task={task} />)}</ul></> : null}
            </div>
          </div>
          <details className="pl-details"><summary>Текст сводки для Telegram</summary><pre className="pl-code" style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 14, marginTop: 10 }}>{brief.text}</pre></details>
        </>
      ) : !error ? <p className="pl-empty">Загружаем план…</p> : null}
    </section>
  )
}
