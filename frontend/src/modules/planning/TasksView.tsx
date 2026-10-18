import { useEffect, useState } from 'react'
import type { PlanningTask } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import { addDays, localDate } from './format'
import TaskRow, { TaskForm } from './TaskRow'

export default function TasksView() {
  const { revision, today, settings, now } = usePlanning()
  const [tasks, setTasks] = useState<PlanningTask[] | null>(null)
  const [error, setError] = useState('')
  const [project, setProject] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    planningApi.tasks(controller.signal).then((value) => { setTasks(value); setError('') }).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [revision])

  const dueDate = (task: PlanningTask) => task.due ? (task.dueHasTime ? localDate(task.due, settings.timeZone) : task.due) : null
  const visible = (tasks || []).filter((task) => !project || task.project === project)
  const open = visible.filter((task) => task.status === 'open').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.priority - b.priority)
  const isOverdue = (task: PlanningTask) => Boolean(task.due) && (task.dueHasTime ? Date.parse(task.due!) < now : task.due! < today)
  const weekEnd = addDays(today, 7)
  const groups = [
    { title: 'Просрочено', tone: 'red', items: open.filter(isOverdue) },
    { title: 'Сегодня', tone: 'accent', items: open.filter((task) => !isOverdue(task) && dueDate(task) === today) },
    { title: 'Ближайшие 7 дней', tone: '', items: open.filter((task) => { const date = dueDate(task); return date && date > today && date <= weekEnd }) },
    { title: 'Позже', tone: '', items: open.filter((task) => { const date = dueDate(task); return date && date > weekEnd }) },
    { title: 'Без срока', tone: '', items: open.filter((task) => !task.due) },
  ].filter((group) => group.items.length)
  const done = visible.filter((task) => task.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
  const projects = [...new Set((tasks || []).map((task) => task.project).filter(Boolean))].sort()

  return (
    <section className="pl-section" aria-labelledby="pl-tasks-title">
      <div className="pl-spread">
        <h2 className="pl-section-title" id="pl-tasks-title">Задачи и обязательства</h2>
        {projects.length ? <label className="pl-field" style={{ width: 220 }}><span className="pl-visually-hidden">Проект</span><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Все проекты</option>{projects.map((item) => <option key={item}>{item}</option>)}</select></label> : null}
      </div>
      <details className="pl-card pl-form-card" open={tasks?.length === 0}>
        <summary className="pl-muted" style={{ cursor: 'pointer' }}>＋ Новая задача</summary>
        <div style={{ marginTop: 14 }}><TaskForm onDone={() => undefined} /></div>
      </details>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      {tasks === null && !error ? <p className="pl-empty">Загружаем задачи…</p> : null}
      {tasks && !open.length ? <p className="pl-empty">Открытых задач нет. Добавьте задачу формой выше или текстом: «оплатить налог до 28-го».</p> : null}
      <div className="pl-groups">
        {groups.map((group) => (
          <div className="pl-card pl-group" key={group.title}>
            <h3>{group.title} <span className={`pl-badge ${group.tone}`}>{group.items.length}</span></h3>
            <ul className="pl-task-list">{group.items.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
          </div>
        ))}
        {done.length ? (
          <details className="pl-card">
            <summary className="pl-muted" style={{ cursor: 'pointer' }}>Выполнено ({done.length})</summary>
            <ul className="pl-task-list">{done.slice(0, 50).map((task) => <TaskRow key={task.id} task={task} />)}</ul>
          </details>
        ) : null}
      </div>
    </section>
  )
}
