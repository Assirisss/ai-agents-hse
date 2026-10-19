import { useEffect, useState } from 'react'
import type { Exercise, HealthSettings, HealthState, Meal, Product, Workout, WorkoutTemplate } from '../../../../shared/health'
import { daySummary, mealNutrition, shiftDate, todayInZone } from '../../../../shared/health-math.mts'
import { healthApi } from './api'
import { ExerciseEditor, ProductEditor, SettingsEditor, WellbeingEditor } from './CatalogEditors'
import WorkoutEditor from './WorkoutEditor'
import type { WorkoutEditorSeed } from './WorkoutEditor'
import MealEditor from './MealEditor'
import ProgressView from './ProgressView'
import AssistantPanel from './AssistantPanel'
import { Empty, Icon, NutritionCards } from './ui'
import { displayDate, errorMessage, fmt, locationLabels, mealLabels } from './format'
import './health.css'

const tabs = [{ id: 'today', label: 'Сегодня', icon: 'sun' }, { id: 'workouts', label: 'Тренировки', icon: 'activity' }, { id: 'nutrition', label: 'Питание', icon: 'food' }, { id: 'progress', label: 'Прогресс', icon: 'chart' }, { id: 'assistant', label: 'Тренер', icon: 'sparkles' }] as const
type View = typeof tabs[number]['id']
type Editor = { kind: 'workout'; seed: WorkoutEditorSeed } | { kind: 'meal'; meal: Meal | null } | { kind: 'product'; product: Product | null } | { kind: 'exercise'; exercise: Exercise | null } | { kind: 'settings' } | { kind: 'wellbeing' }
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow'
const defaultSettings = (): HealthSettings => ({ timeZone: browserZone(), goals: { calories: null, protein: null, fat: null, carbs: null } })
export default function HealthPage() {
  const [state, setState] = useState<HealthState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<View>('today')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [date, setDate] = useState(() => todayInZone(browserZone()))
  const [today, setToday] = useState(date)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [workoutTab, setWorkoutTab] = useState<'history' | 'templates' | 'exercises'>('history')
  const [nutritionTab, setNutritionTab] = useState<'diary' | 'products'>('diary')
  const settings = state?.settings ?? defaultSettings()
  useEffect(() => {
    const controller = new AbortController()
    healthApi.state(controller.signal).then(async value => {
      if (controller.signal.aborted) return
      if (!value.settings) value.settings = await healthApi.settings(defaultSettings())
      if (!controller.signal.aborted) { setState(value); setLoading(false) }
    }).catch(cause => { if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoading(false) } })
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    function tick() {
      const next = todayInZone(settings.timeZone)
      setToday(previous => { if (previous !== next) setDate(selected => selected === previous ? next : selected); return next })
    }
    tick()
    const timer = window.setInterval(tick, 30000)
    return () => window.clearInterval(timer)
  }, [settings.timeZone])
  function reload() { setLoading(true); setError(''); setRetry(value => value + 1) }
  async function saved() {
    setEditor(null); setNotice('Изменения сохранены.'); reload()
  }
  function navigate(next: View) { setView(next); setNotice('') }
  function newWorkout() { setEditor({ kind: 'workout', seed: { kind: 'workouts' } }) }
  function newMeal() { setEditor({ kind: 'meal', meal: null }) }
  function cloneWorkout(value: Workout | WorkoutTemplate, source: 'workouts' | 'templates', target: 'workouts' | 'templates') {
    setEditor({ kind: 'workout', seed: { kind: target, value, source: { kind: source, id: value.id } } })
  }
  const summary = state ? daySummary(state, date) : null
  const ready = Boolean(state) && !loading && !error
  const dateControl = <div className="sp-date-control"><button className="sp-secondary" aria-label="Предыдущий день" disabled={date <= '1900-01-01'} onClick={() => setDate(shiftDate(date, -1))}>‹</button><label className="sp-sr-only" htmlFor="sp-date">Дата дневника</label><input id="sp-date" type="date" min="1900-01-01" max="2200-12-31" value={date} onChange={e => { if (e.target.validity.valid && e.target.value) setDate(e.target.value) }} /><button className="sp-secondary" aria-label="Следующий день" disabled={date >= '2200-12-31'} onClick={() => setDate(shiftDate(date, 1))}>›</button><button className="sp-text" onClick={() => setDate(today)}>Сегодня</button></div>
  const mealList = (meals: Meal[]) => meals.length ? <div className="sp-records">{meals.map(meal => <button key={meal.id} className="sp-record" onClick={() => setEditor({ kind: 'meal', meal })}>{meal.hasPhoto ? <img src={healthApi.photo(meal.id, meal.photoVersion)} alt="" loading="lazy" /> : <span className="sp-record-icon"><Icon name="food" /></span>}<span className="sp-record-copy"><strong>{meal.name}</strong><small>{mealLabels[meal.kind]} · {meal.items.map(item => item.product.name).join(', ')}</small></span><span className="sp-record-number">{fmt(mealNutrition(meal).calories, 0)}<small>ккал</small></span><Icon name="arrow" size={16} /></button>)}</div> : <Empty title="Что было на тарелке?" action={<button className="sp-secondary" onClick={newMeal}>Добавить еду</button>}>Сохраните первый приём пищи за этот день.</Empty>
  const workoutList = (workouts: Workout[]) => workouts.length ? <div className="sp-records">{workouts.map(workout => <div className="sp-workout-record" key={workout.id}><button className="sp-record" onClick={() => setEditor({ kind: 'workout', seed: { kind: 'workouts', value: workout, id: workout.id } })}><span className="sp-record-icon"><Icon name="activity" /></span><span className="sp-record-copy"><strong>{workout.name}</strong><small>{displayDate(workout.date)} · {locationLabels[workout.location]} · {workout.entries.map(item => item.exercise.name).join(', ')}</small></span><Icon name="arrow" size={16} /></button><div className="sp-record-actions"><button className="sp-text" onClick={() => cloneWorkout(workout, 'workouts', 'workouts')}>Повторить</button><button className="sp-text" onClick={() => cloneWorkout(workout, 'workouts', 'templates')}>В шаблон</button></div></div>)}</div> : <Empty title="Место для движения" action={<button className="sp-secondary" onClick={newWorkout}>Добавить тренировку</button>}>Записывайте упражнения и возвращайтесь к своим результатам.</Empty>
  return <section className="sp-page" aria-labelledby="sp-title"><header className="sp-page-header"><div><p className="eyebrow">Личное пространство</p><h1 className="screen-title" id="sp-title">Спорт и питание</h1><p className="sp-subtitle">Ваш ритм. Осознанное питание. Маленькие шаги каждый день.</p></div><div className="sp-header-actions"><button className="sp-secondary" disabled={!ready} onClick={() => setEditor({ kind: 'settings' })}>Цели и настройки</button><button className="sp-primary" disabled={!ready} onClick={view === 'nutrition' ? newMeal : newWorkout}><Icon name="plus" size={17} />{view === 'nutrition' ? 'Добавить еду' : 'Тренировка'}</button></div></header>
    <div className="sp-overview">{([{ icon: 'activity', label: 'Тренировок за 7 дней', value: state ? state.workouts.filter(item => item.date >= shiftDate(today, -6) && item.date <= today).length : '—', target: 'workouts' }, { icon: 'food', label: 'Калорий сегодня', value: state ? fmt(daySummary(state, today).nutrition.calories, 0) : '—', target: 'nutrition' }, { icon: 'sun', label: 'Самочувствие сегодня', value: state ? (state.wellbeing.find(item => item.date === today)?.score ? `${state.wellbeing.find(item => item.date === today)!.score} / 5` : '—') : '—', target: 'today' }] as const).map(card => <button key={card.target} className="sp-overview-card" disabled={!ready} onClick={() => { navigate(card.target); setDate(today) }}><span className={`sp-overview-icon sp-${card.icon}`}><Icon name={card.icon} size={23} /></span><span><strong>{card.value}</strong><small>{card.label}</small></span><Icon name="arrow" size={16} /></button>)}</div>
    <div className="sp-tabs" role="tablist" aria-label="Разделы спорта и питания" onKeyDown={event => {
      const index = tabs.findIndex(tab => tab.id === view)
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); navigate(tabs[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>{tabs.map(tab => <button key={tab.id} role="tab" id={`sp-tab-${tab.id}`} aria-selected={view === tab.id} aria-controls={`sp-panel-${tab.id}`} tabIndex={view === tab.id ? 0 : -1} className={view === tab.id ? 'is-active' : ''} onClick={() => navigate(tab.id)}><Icon name={tab.icon} size={17} />{tab.label}</button>)}</div>
    {notice && <div className="sp-notice" role="status">{notice}<button aria-label="Скрыть сообщение" onClick={() => setNotice('')}>×</button></div>}
    {error && <div className="sp-error" role="alert">{error}<button className="sp-secondary" onClick={reload}>Повторить загрузку</button></div>}
    {loading && <p className="sp-loading" role="status">Загружаем ваш дневник…</p>}
    {ready && state && summary && <div role="tabpanel" id={`sp-panel-${view}`} aria-labelledby={`sp-tab-${view}`} tabIndex={0}>
      {view === 'today' && <div className="sp-stack"><div className="sp-section-title"><div><h2>{date === today ? 'Сегодня — хороший день для себя' : displayDate(date)}</h2><p className="sp-hint">Все записи выбранного дня в одном месте</p></div>{dateControl}</div><NutritionCards value={summary.nutrition} goals={settings.goals} /><div className="sp-two-columns"><section className="sp-card"><div className="sp-section-title"><h3>Тренировки</h3><button className="sp-text" onClick={newWorkout}>+ Добавить</button></div>{workoutList(summary.workouts)}</section><section className="sp-card"><div className="sp-section-title"><h3>Питание</h3><button className="sp-text" onClick={newMeal}>+ Добавить</button></div>{mealList(summary.meals)}</section></div><button className="sp-wellbeing" onClick={() => setEditor({ kind: 'wellbeing' })}><span className="sp-overview-icon sp-sun"><Icon name="sun" /></span><span><strong>{summary.wellbeing ? `Самочувствие: ${summary.wellbeing.score} из 5` : 'Как вы себя чувствуете?'}</strong><small>{summary.wellbeing?.note || 'Одна короткая отметка, чтобы замечать своё состояние'}</small></span><Icon name="arrow" /></button></div>}
      {view === 'workouts' && <div className="sp-stack"><div className="sp-section-title"><h2>Дневник движения</h2><div className="sp-segments">{([{ id: 'history', text: 'История' }, { id: 'templates', text: 'Шаблоны' }, { id: 'exercises', text: 'Упражнения' }] as const).map(item => <button key={item.id} aria-pressed={workoutTab === item.id} className={workoutTab === item.id ? 'is-active' : ''} onClick={() => setWorkoutTab(item.id)}>{item.text}</button>)}</div></div>
        {workoutTab === 'history' && <><div className="sp-inline"><label>С<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>По<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><button className="sp-text" onClick={() => { setFrom(''); setTo('') }}>Все даты</button></div>{from && to && from > to ? <p className="sp-error">Начало периода должно быть раньше конца.</p> : workoutList(state.workouts.filter(item => (!from || item.date >= from) && (!to || item.date <= to)).sort((a, b) => b.date.localeCompare(a.date)))}</>}
        {workoutTab === 'templates' && <><div className="sp-section-title"><p className="sp-hint">Любимые тренировки, готовые к повторению.</p><button className="sp-secondary" onClick={() => setEditor({ kind: 'workout', seed: { kind: 'templates' } })}>+ Создать шаблон</button></div>{state.templates.length ? <div className="sp-catalog-grid">{state.templates.map(template => <article className="sp-card" key={template.id}><Icon name="activity" /><h3>{template.name}</h3><p className="sp-hint">{template.entries.map(entry => entry.exercise.name).join(' · ')}</p><div className="sp-inline"><button className="sp-primary" onClick={() => cloneWorkout(template, 'templates', 'workouts')}>Начать тренировку</button><button className="sp-text" onClick={() => setEditor({ kind: 'workout', seed: { kind: 'templates', id: template.id, value: template } })}>Изменить</button></div></article>)}</div> : <Empty title="Повторять стало проще">Сохраните тренировку как шаблон или создайте его с нуля.</Empty>}</>}
        {workoutTab === 'exercises' && <><div className="sp-section-title"><p className="sp-hint">Справочник силовых упражнений и кардио.</p><button className="sp-secondary" onClick={() => setEditor({ kind: 'exercise', exercise: null })}>+ Упражнение</button></div><div className="sp-catalog-grid">{state.exercises.map(exercise => <button key={exercise.id} className="sp-catalog-item" onClick={() => setEditor({ kind: 'exercise', exercise })}><Icon name="activity" /><span><strong>{exercise.name}</strong><small>{exercise.kind === 'cardio' ? 'Кардио' : exercise.bodyweight ? 'Собственный вес' : 'Силовое'}</small></span><Icon name="arrow" size={16} /></button>)}</div>{!state.exercises.length && <Empty title="Создайте упражнение">Добавьте своё первое упражнение в справочник.</Empty>}</>}
      </div>}
      {view === 'nutrition' && <div className="sp-stack"><div className="sp-section-title"><h2>Питание в вашем ритме</h2><div className="sp-segments"><button aria-pressed={nutritionTab === 'diary'} className={nutritionTab === 'diary' ? 'is-active' : ''} onClick={() => setNutritionTab('diary')}>Дневник</button><button aria-pressed={nutritionTab === 'products'} className={nutritionTab === 'products' ? 'is-active' : ''} onClick={() => setNutritionTab('products')}>Мои продукты</button></div></div>{nutritionTab === 'diary' ? <>{dateControl}<NutritionCards value={summary.nutrition} goals={settings.goals} />{mealList(summary.meals)}</> : <><div className="sp-section-title"><label className="sp-grow">Поиск по продуктам<input type="search" placeholder="Название или марка" value={catalogQuery} onChange={e => setCatalogQuery(e.target.value)} /></label><button className="sp-secondary" onClick={() => setEditor({ kind: 'product', product: null })}>+ Продукт</button></div>{state.products.length ? <div className="sp-catalog-grid">{state.products.filter(item => `${item.name} ${item.brand}`.toLocaleLowerCase().includes(catalogQuery.toLocaleLowerCase())).map(product => <button className="sp-catalog-item" key={product.id} onClick={() => setEditor({ kind: 'product', product })}><Icon name="food" /><span><strong>{product.name}</strong><small>{product.brand || 'Свой продукт'} · {fmt(product.per100.calories)} ккал / 100 г</small></span><Icon name="arrow" size={16} /></button>)}</div> : <Empty title="Знакомые продукты — под рукой" action={<button className="sp-secondary" onClick={() => setEditor({ kind: 'product', product: null })}>Создать продукт</button>}>Введите КБЖУ с упаковки один раз и используйте продукт в дневнике.</Empty>}{state.products.length > 0 && !state.products.some(item => `${item.name} ${item.brand}`.toLocaleLowerCase().includes(catalogQuery.toLocaleLowerCase())) && <p className="sp-hint">По этому запросу ничего не найдено.</p>}</>}</div>}
      {view === 'progress' && <div className="sp-stack">{dateControl}<ProgressView state={state} date={date} /></div>}
      {view === 'assistant' && <AssistantPanel state={state} date={date} onSaved={saved} onCatalogChange={patch => setState(current => current ? { ...current, ...patch } : current)} />}
    </div>}
    {editor?.kind === 'workout' && state && <WorkoutEditor seed={editor.seed} date={date} exercises={state.exercises} onClose={() => { setEditor(null); reload() }} onSaved={saved} />}
    {editor?.kind === 'meal' && state && <MealEditor meal={editor.meal} date={date} products={state.products} onClose={() => { setEditor(null); reload() }} onSaved={saved} />}
    {editor?.kind === 'product' && <ProductEditor product={editor.product} onClose={() => setEditor(null)} onSaved={saved} />}
    {editor?.kind === 'exercise' && <ExerciseEditor exercise={editor.exercise} onClose={() => setEditor(null)} onSaved={saved} />}
    {editor?.kind === 'settings' && <SettingsEditor settings={settings} onClose={() => setEditor(null)} onSaved={saved} />}
    {editor?.kind === 'wellbeing' && <WellbeingEditor date={date} record={summary?.wellbeing ?? undefined} onClose={() => setEditor(null)} onSaved={saved} />}
  </section>
}
