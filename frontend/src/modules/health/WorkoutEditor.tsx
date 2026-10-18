import { useState } from 'react'
import type { Exercise, Workout, WorkoutEntry, WorkoutTemplate } from '../../../../shared/health'
import { adjustSets } from '../../../../shared/health-math.mts'
import { healthApi } from './api'
import { EditorDialog } from './ui'
import { locationLabels, uid } from './format'
export type WorkoutEditorSeed = { value?: Workout | WorkoutTemplate; id?: string; kind: 'workouts' | 'templates'; source?: { kind: 'workouts' | 'templates'; id: string } }
export default function WorkoutEditor({ seed, date, exercises, onClose, onSaved }: { seed: WorkoutEditorSeed; date: string; exercises: Exercise[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(seed.value?.name ?? '')
  const [day, setDay] = useState(seed.id && seed.value && 'date' in seed.value ? seed.value.date : date)
  const [location, setLocation] = useState<Workout['location']>(seed.value?.location ?? 'gym')
  const [note, setNote] = useState(seed.value?.note ?? '')
  const [entries, setEntries] = useState<WorkoutEntry[]>(() => structuredClone(seed.value?.entries ?? []))
  const [chosen, setChosen] = useState(exercises[0]?.id ?? '')
  const [field, setField] = useState<'weight' | 'reps'>('weight')
  const [delta, setDelta] = useState(0)
  const patch = (id: string, value: Partial<WorkoutEntry>) => setEntries(current => current.map(item => item.id === id ? { ...item, ...value } : item))
  function add() {
    const exercise = exercises.find(item => item.id === chosen)
    if (!exercise) return
    setEntries(current => [...current, { id: uid(), exerciseId: exercise.id, exercise, sets: exercise.kind === 'strength' ? [{ reps: 10, weight: 0 }] : [], minutes: exercise.kind === 'cardio' ? 20 : null, distanceKm: null }])
  }
  return <EditorDialog wide title={seed.kind === 'templates' ? 'Шаблон тренировки' : seed.id ? 'Изменить тренировку' : 'Новая тренировка'} onClose={onClose} onSave={async () => {
    if (!entries.length) throw new Error('Добавьте хотя бы одно упражнение')
    await healthApi.save(seed.kind, { name, date: day, location, note, entries, source: seed.source }, seed.id); await onSaved()
  }} onDelete={seed.id ? async () => { await healthApi.remove(seed.kind, seed.id!); await onSaved() } : undefined}>
    <div className="sp-fields"><label>Название<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Например, тренировка ног" /></label>{seed.kind === 'workouts' && <label>Дата<input type="date" required value={day} onChange={e => setDay(e.target.value)} /></label>}<label>Место<select value={location} onChange={e => setLocation(e.target.value as Workout['location'])}>{Object.entries(locationLabels).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label></div>
    <div className="sp-section-title"><h3>Упражнения</h3><span>{entries.length}</span></div>
    {entries.map((entry, index) => <section className="sp-exercise-block" key={entry.id}><div className="sp-section-title"><div><h3>{index + 1}. {entry.exercise.name}</h3><p className="sp-hint">{entry.exercise.kind === 'cardio' ? 'Кардио' : entry.exercise.bodyweight ? 'Собственный вес · укажите только дополнительный вес' : 'Силовое · вес в килограммах'}</p></div><button type="button" className="sp-text" onClick={() => setEntries(current => current.filter(item => item.id !== entry.id))}>Убрать</button></div>
      {entry.exercise.kind === 'strength' ? <><div className="sp-set-head"><span>Подход</span><span>Повторения</span><span>{entry.exercise.bodyweight ? 'Доп. вес, кг' : 'Вес, кг'}</span><span /></div>{entry.sets.map((set, i) => <div className="sp-set-row" key={i}><span>{i + 1}</span><input aria-label={`${entry.exercise.name}: повторения ${i + 1}`} type="number" required min="1" max="1000" step="1" value={Number.isNaN(set.reps) ? '' : set.reps} onChange={e => patch(entry.id, { sets: entry.sets.map((s, n) => n === i ? { ...s, reps: e.target.valueAsNumber } : s) })} /><input aria-label={`${entry.exercise.name}: вес ${i + 1}`} type="number" required min="0" max="2000" step="any" value={Number.isNaN(set.weight) ? '' : set.weight} onChange={e => patch(entry.id, { sets: entry.sets.map((s, n) => n === i ? { ...s, weight: e.target.valueAsNumber } : s) })} /><button type="button" aria-label={`Удалить подход ${i + 1}`} disabled={entry.sets.length === 1} className="sp-text" onClick={() => patch(entry.id, { sets: entry.sets.filter((_, n) => i !== n) })}>×</button></div>)}<button type="button" className="sp-text" onClick={() => patch(entry.id, { sets: [...entry.sets, { ...entry.sets.at(-1)! }] })}>+ Подход</button></> : <div className="sp-fields"><label>Длительность, мин<input type="number" required min="0.1" max="10080" step="any" value={entry.minutes ?? ''} onChange={e => patch(entry.id, { minutes: e.target.valueAsNumber })} /></label><label>Расстояние, км · необязательно<input type="number" min="0.001" max="2000" step="any" value={entry.distanceKm ?? ''} onChange={e => patch(entry.id, { distanceKm: e.target.value === '' ? null : e.target.valueAsNumber })} /></label></div>}
    </section>)}
    <div className="sp-inline"><label className="sp-grow">Добавить упражнение<select value={chosen} onChange={e => setChosen(e.target.value)}>{!exercises.length && <option value="">Сначала создайте упражнение в справочнике</option>}{exercises.map(exercise => <option value={exercise.id} key={exercise.id}>{exercise.name}</option>)}</select></label><button type="button" className="sp-secondary" disabled={!chosen} onClick={add}>Добавить</button></div>
    {entries.some(item => item.exercise.kind === 'strength') && <details className="sp-details"><summary>Изменить все силовые подходы</summary><div className="sp-inline"><label>Параметр<select value={field} onChange={e => setField(e.target.value as 'weight' | 'reps')}><option value="weight">Вес, кг</option><option value="reps">Повторения</option></select></label><label>Изменить на<input type="number" step={field === 'reps' ? 1 : 'any'} value={Number.isNaN(delta) ? '' : delta} onChange={e => setDelta(e.target.valueAsNumber)} /></label><button type="button" className="sp-secondary" onClick={() => { if (!Number.isFinite(delta) || (field === 'reps' && !Number.isInteger(delta))) return; setEntries(adjustSets(entries, field, delta)) }}>Применить</button></div><p className="sp-hint">Меняется только этот черновик. Вес не опускается ниже 0, повторения — ниже 1.</p></details>}
    <label>Заметка<textarea rows={3} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></label>
  </EditorDialog>
}
