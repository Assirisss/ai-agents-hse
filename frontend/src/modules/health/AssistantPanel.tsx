import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { HealthAiInput, HealthAiOperation, HealthAiReply, HealthCapabilities, HealthState, Workout } from '../../../../shared/health'
import { healthApi } from './api'
import { errorMessage, fmt, locationLabels } from './format'
import { Icon } from './ui'
import WorkoutEditor from './WorkoutEditor'
import MealEditor from './MealEditor'
import type { MealEditorSeed } from './MealEditor'
import { FoodReview, WorkoutReview } from './AssistantReview'

const operations = [
  { id: 'parse-workout', title: 'Тренировка словами', description: 'Перенести упражнения из текста в черновик.' },
  { id: 'recognize-food', title: 'Еда по фото', description: 'Предположить состав блюда или прочитать этикетку.' },
  { id: 'explain-progress', title: 'Объяснить прогресс', description: 'Посмотреть на факты из вашего дневника.' },
  { id: 'suggest-workout', title: 'Предложить тренировку', description: 'Составить вариант под ваше время и оборудование.' },
] as const
type CatalogPatch = Partial<Pick<HealthState, 'products' | 'exercises'>>
type Response = { reply: Extract<HealthAiReply, { status: 'completed' }>; input: HealthAiInput; key: number }

export default function AssistantPanel({ state, date, onSaved, onCatalogChange }: { state: HealthState; date: string; onSaved: () => Promise<void>; onCatalogChange: (value: CatalogPatch) => void }) {
  const [capabilities, setCapabilities] = useState<HealthCapabilities | null>(null)
  const [capsError, setCapsError] = useState('')
  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<HealthAiOperation>('parse-workout')
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState('')
  const [reading, setReading] = useState(false)
  const fileSequence = useRef(0)
  const [mode, setMode] = useState<'dish' | 'label'>('dish')
  const [day, setDay] = useState(date)
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [exerciseId, setExerciseId] = useState('')
  const [location, setLocation] = useState<Workout['location']>('home')
  const [minutes, setMinutes] = useState(30)
  const [equipment, setEquipment] = useState('Без оборудования')
  const [experience, setExperience] = useState<'beginner' | 'regular'>('beginner')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [response, setResponse] = useState<Response | null>(null)
  const [workout, setWorkout] = useState<Workout | null>(null)
  const [meal, setMeal] = useState<MealEditorSeed | null>(null)
  const active = useRef<AbortController | null>(null)
  const output = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    healthApi.capabilities(controller.signal).then(value => { if (!controller.signal.aborted) { setCapabilities(value); setCapsError('') } }).catch(cause => { if (!controller.signal.aborted) setCapsError(errorMessage(cause)) })
    return () => controller.abort()
  }, [retry])
  useEffect(() => () => { active.current?.abort(); fileSequence.current++ }, [])
  useEffect(() => { if (response) output.current?.focus() }, [response])
  async function readPhoto(file?: File) {
    if (!file) return
    const sequence = ++fileSequence.current
    setReading(true); setError('')
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) throw new Error('Выберите JPEG, PNG или WebP до 6 МиБ')
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Не удалось прочитать фотографию')); reader.readAsDataURL(file) })
      if (sequence === fileSequence.current) setPhoto(data)
    } catch (cause) { if (sequence === fileSequence.current) setError(errorMessage(cause)) }
    finally { if (sequence === fileSequence.current) setReading(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !capabilities?.ai) return
    const input: HealthAiInput = operation === 'parse-workout' ? { operation, text, date: day }
      : operation === 'recognize-food' ? { operation, text, photo, mode, date: day }
      : operation === 'explain-progress' ? { operation, to: day, days, ...(exerciseId ? { exerciseId } : {}) }
      : { operation, text, date: day, location, minutes, equipment, experience }
    if (operation === 'recognize-food' && !photo) { setError('Выберите фотографию'); return }
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    try {
      const reply = await healthApi.assistant(input, AbortSignal.any([controller.signal, AbortSignal.timeout(325000)]))
      if (controller.signal.aborted) return
      if (reply.status === 'unavailable') setError(reply.message)
      else setResponse({ reply, input, key: Date.now() })
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)) }
    finally {
      if (active.current === controller) { active.current = null; setBusy(false); setRetry(value => value + 1) }
    }
  }
  const exhausted = capabilities?.ai && capabilities.monthlyRequests.used >= capabilities.monthlyRequests.limit
  const reply = response?.reply
  return <div className="sp-stack sp-assistant"><div className="sp-assistant-heading"><span className="sp-empty-icon"><Icon name="sparkles" size={28} /></span><h2>Тренер по спорту и питанию</h2><p>Разберите фото, запишите тренировку или обсудите прогресс. Вы проверяете результат перед сохранением.</p></div>
    {capsError ? <div className="sp-error" role="alert">{capsError}<button className="sp-secondary" onClick={() => setRetry(value => value + 1)}>Повторить</button></div> : !capabilities ? <p role="status" className="sp-hint">Проверяем подключение тренера…</p> : <p className="sp-hint">{capabilities.ai ? `Runpod · ${capabilities.monthlyRequests.used} из ${capabilities.monthlyRequests.limit} запросов за месяц` : capabilities.aiUnavailable?.message ?? 'Тренер ещё не подключён. Ручной дневник работает.'}</p>}
    <div className="sp-catalog-grid sp-assistant-grid" aria-label="Возможности тренера">{operations.map(item => <button type="button" className={`sp-card sp-ai-operation${operation === item.id ? ' is-active' : ''}`} key={item.id} disabled={busy} aria-pressed={operation === item.id} onClick={() => { setOperation(item.id); setError(''); setText(''); setResponse(null) }}><h3>{item.title}</h3><span className="sp-hint">{item.description}</span></button>)}</div>
    <form className="sp-card sp-stack" onSubmit={submit}><fieldset disabled={busy || reading} className="sp-stack">
      <label>{operation === 'explain-progress' ? 'Период заканчивается' : 'Дата записи'}<input type="date" required min="1900-01-01" max="2200-12-31" value={day} onChange={e => setDay(e.target.value)} /></label>
      {operation === 'recognize-food' && <><label>Что на фото<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="dish">Блюдо</option><option value="label">Этикетка с КБЖУ на 100 г</option></select></label><div className="sp-photo-section">{photo && <img src={photo} alt="Фото для разбора" />}<div><label className="sp-file">{reading ? 'Чтение…' : photo ? 'Заменить фото' : 'Выбрать фото'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { void readPhoto(e.target.files?.[0]); e.target.value = '' }} /></label>{photo && <button type="button" className="sp-text" onClick={() => setPhoto('')}>Убрать</button>}<p className="sp-hint">JPEG, PNG, WebP до 6 МиБ. Фото отправится в Runpod после нажатия «Разобрать».</p></div></div></>}
      {operation !== 'explain-progress' && <label>{operation === 'parse-workout' ? 'Что вы сделали' : operation === 'recognize-food' ? 'Что известно о блюде · необязательно' : 'Цель и ограничения'}<textarea rows={4} required={operation !== 'recognize-food'} maxLength={4000} value={text} onChange={e => setText(e.target.value)} placeholder={operation === 'parse-workout' ? 'Жим лёжа: 3 подхода по 10 повторений, 40 кг. Бег 20 минут.' : operation === 'recognize-food' ? 'Например: рис 150 г в готовом виде, курица без масла.' : 'Например: спокойная тренировка всего тела, без прыжков.'} /></label>}
      {operation === 'suggest-workout' && <><div className="sp-fields"><label>Место<select value={location} onChange={e => setLocation(e.target.value as typeof location)}>{Object.entries(locationLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>Время, мин<input required type="number" min="5" max="180" value={Number.isNaN(minutes) ? '' : minutes} onChange={e => setMinutes(e.target.valueAsNumber)} /></label><label>Опыт<select value={experience} onChange={e => setExperience(e.target.value as typeof experience)}><option value="beginner">Начинающий</option><option value="regular">Тренируюсь регулярно</option></select></label><label>Доступное оборудование<input required maxLength={500} value={equipment} onChange={e => setEquipment(e.target.value)} /></label></div><p className="sp-hint">Рабочий вес вы выбираете самостоятельно. Предложение можно изменить в форме тренировки.</p></>}
      {operation === 'explain-progress' && <div className="sp-fields"><label>Период<select value={days} onChange={e => setDays(Number(e.target.value) as typeof days)}>{[7, 30, 90].map(n => <option key={n} value={n}>{n} дней</option>)}</select></label><label>Упражнение · необязательно<select value={exerciseId} onChange={e => setExerciseId(e.target.value)}><option value="">Общая статистика</option>{state.exercises.map(exercise => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label></div>}
    </fieldset>
    {exhausted && <p className="sp-hint">Лимит запросов за этот месяц исчерпан. Можно продолжить вести дневник вручную.</p>}
    {busy ? <div className="sp-inline"><p className="sp-hint" role="status">Ожидаем Runpod. Первый запуск может занять несколько минут…</p><button type="button" className="sp-secondary" onClick={() => { active.current?.abort(); setError('Отмена отправлена. Удалённая задача отменяется по возможности; автоматического повтора нет.') }}>Отменить запрос</button></div> : <button className="sp-primary" disabled={!capabilities?.ai || Boolean(exhausted) || reading}>{operation === 'recognize-food' ? 'Разобрать' : operation === 'parse-workout' ? 'Создать черновик' : operation === 'explain-progress' ? 'Объяснить' : 'Предложить'}</button>}
    {error && <p className="sp-error" role="alert">{error}</p>}</form>
    {response && reply && <div ref={output} tabIndex={-1} className="sp-card sp-stack sp-ai-result" key={response.key}><div className="sp-section-title"><h2>Предложение тренера</h2><span className="sp-badge">Проверьте перед сохранением</span></div><p>{reply.message}</p>{reply.questions.length > 0 && <div><h3>Нужно уточнить</h3><ul>{reply.questions.map((question, i) => <li key={i}>{question}</li>)}</ul><p className="sp-hint">{reply.operation === 'explain-progress' ? 'Добавьте записи в дневник и повторите анализ.' : 'Дополните описание выше и отправьте запрос повторно либо исправьте черновик вручную.'}</p></div>}{reply.warnings.length > 0 && <ul className="sp-hint">{reply.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      {(reply.operation === 'parse-workout' || reply.operation === 'suggest-workout') && 'date' in response.input && <WorkoutReview draft={reply.workout} date={response.input.date} note={`Черновик AI. ${reply.message}`.slice(0, 4000)} exercises={state.exercises} onCatalog={exercises => onCatalogChange({ exercises })} onOpen={setWorkout} />}
      {reply.operation === 'recognize-food' && response.input.operation === 'recognize-food' && <FoodReview draft={reply.food} products={state.products} onCatalog={products => onCatalogChange({ products })} onOpen={items => { if (response.input.operation === 'recognize-food') setMeal({ name: reply.food.name, date: response.input.date, photo: response.input.photo, note: 'Состав предложен AI; продукты и массу подтвердил пользователь.', items }) }} />}
      {reply.operation === 'explain-progress' && <><div className="sp-stack">{reply.observations.map((item, i) => { const fact = reply.facts.find(fact => fact.id === item.factId)!; return <article key={i}><h3>{fact.label}: {fact.value === null ? 'нет данных' : `${fmt(fact.value)} ${fact.unit}`}</h3><p className="sp-hint">{item.text}</p></article> })}</div><details className="sp-details"><summary>Исходные показатели</summary><ul>{reply.facts.map(fact => <li key={fact.id}>{fact.label}: {fact.value === null ? 'нет данных' : `${fmt(fact.value)} ${fact.unit}`}</li>)}</ul></details></>}
      <p className="sp-hint">{reply.model} · {reply.executionMs === null ? 'Время обработки неизвестно' : `${fmt(reply.executionMs / 1000)} с обработки`}. Стоимость с учётом запуска и хранения доступна в Runpod.</p>
    </div>}
    {workout && <WorkoutEditor seed={{ kind: 'workouts', value: workout }} date={workout.date} exercises={state.exercises} onClose={() => setWorkout(null)} onSaved={onSaved} />}
    {meal && <MealEditor meal={null} seed={meal} date={meal.date} products={state.products} onClose={() => setMeal(null)} onSaved={onSaved} />}
  </div>
}
