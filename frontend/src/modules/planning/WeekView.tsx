import { useEffect, useState } from 'react'
import type { Agenda } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import { addDays, localTime, shortDay, startOfWeek } from './format'

export default function WeekView() {
  const { today, revision, settings, openEditor, refresh } = usePlanning()
  const [from, setFrom] = useState(startOfWeek(today))
  const [agenda, setAgenda] = useState<Agenda | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    planningApi.agenda(from, 7, controller.signal).then((value) => { setAgenda(value); setError('') }).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [from, revision, settings.timeZone])

  async function complete(id: string) {
    try { await planningApi.completeTask(id); refresh() } catch (cause) { setError(errorText(cause)) }
  }

  const label = `${new Date(`${from}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })} — ${new Date(`${addDays(from, 6)}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`
  return (
    <section className="pl-section" aria-labelledby="pl-week-title">
      <div className="pl-daynav">
        <h2 id="pl-week-title">{label}</h2>
        <button type="button" className="pl-icon-button" aria-label="Предыдущая неделя" onClick={() => setFrom(addDays(from, -7))}>‹</button>
        <button type="button" className="pl-button secondary small" disabled={from === startOfWeek(today)} onClick={() => setFrom(startOfWeek(today))}>Эта неделя</button>
        <button type="button" className="pl-icon-button" aria-label="Следующая неделя" onClick={() => setFrom(addDays(from, 7))}>›</button>
      </div>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      {agenda ? (
        <div className="pl-week">
          {agenda.days.map((day) => (
            <div className={`pl-week-day${day.date === today ? ' today' : ''}`} key={day.date}>
              <header><strong>{shortDay(day.date)}</strong>{day.occurrences.length + day.tasks.length ? <span>{day.occurrences.length + day.tasks.length}</span> : null}</header>
              {day.occurrences.map((item) => (
                <button type="button" key={`${item.eventId}|${item.start}`} className={`pl-chip ${item.source === 'google' || item.source === 'yandex' ? item.source : ''}`}
                  onClick={() => openEditor({ mode: 'edit', eventId: item.eventId, occurrenceStart: item.recurring ? item.start : undefined })} title={item.title}>
                  <span className="time">{item.allDay ? 'весь день' : `${localTime(item.start, settings.timeZone)}–${localTime(item.end, settings.timeZone)}`}</span>
                  <span className="title">{item.recurring ? '↻ ' : ''}{item.title}</span>
                </button>
              ))}
              {day.tasks.map((task) => (
                <button type="button" key={task.id} className={`pl-chip task${task.status === 'done' ? ' done' : ''}`} title={task.status === 'open' ? 'Отметить выполненной' : task.title} onClick={() => task.status === 'open' && complete(task.id)}>
                  <span className="time">{task.status === 'done' ? '✓ выполнено' : task.dueHasTime && task.due ? `☐ до ${localTime(task.due, settings.timeZone)}` : '☐ задача'}</span>
                  <span className="title">{task.title}</span>
                </button>
              ))}
              <button type="button" className="pl-add-day" onClick={() => openEditor({ mode: 'create', date: day.date })}>＋ событие</button>
            </div>
          ))}
        </div>
      ) : !error ? <p className="pl-empty">Загружаем неделю…</p> : null}
      {agenda?.overdue.length ? <p className="pl-notice warning">Просроченных задач: {agenda.overdue.length}. Они на вкладке «Задачи».</p> : null}
    </section>
  )
}
