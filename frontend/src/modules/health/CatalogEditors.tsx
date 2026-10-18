import { useState } from 'react'
import type { Exercise, HealthSettings, Product, Wellbeing } from '../../../../shared/health'
import { healthApi } from './api'
import { EditorDialog } from './ui'
import { labels, nutrientKeys, blankProduct } from './format'

type Callbacks = { onClose: () => void; onSaved: () => Promise<void> }
export function ProductFields({ value, onChange }: { value: Omit<Product, 'id'>; onChange: (value: Omit<Product, 'id'>) => void }) {
  return <><div className="sp-fields"><label>Название продукта<input required maxLength={120} value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} /></label><label>Марка · необязательно<input maxLength={120} value={value.brand} onChange={e => onChange({ ...value, brand: e.target.value })} /></label></div><p className="sp-hint">Пищевая ценность на 100 г — с упаковки продукта.</p><div className="sp-fields sp-four">{nutrientKeys.map(key => <label key={key}>{labels[key]} · {key === 'calories' ? 'ккал' : 'г'}<input type="number" required min="0" max={key === 'calories' ? 10000 : 100} step="any" value={Number.isNaN(value.per100[key]) ? '' : value.per100[key]} onChange={e => onChange({ ...value, per100: { ...value.per100, [key]: e.target.valueAsNumber } })} /></label>)}</div></>
}
export function ProductEditor({ product, onClose, onSaved }: Callbacks & { product: Product | null }) {
  const [value, setValue] = useState<Omit<Product, 'id'>>(product ?? blankProduct())
  return <EditorDialog title={product ? 'Изменить продукт' : 'Новый продукт'} onClose={onClose} onSave={async () => { await healthApi.save('products', value, product?.id); await onSaved() }} onDelete={product ? async () => { await healthApi.remove('products', product.id); await onSaved() } : undefined}><ProductFields value={value} onChange={setValue} /><p className="sp-hint">Изменения справочника не меняют прошлые записи питания.</p></EditorDialog>
}
export function ExerciseEditor({ exercise, onClose, onSaved }: Callbacks & { exercise: Exercise | null }) {
  const [value, setValue] = useState<Omit<Exercise, 'id'>>(exercise ?? { name: '', kind: 'strength', bodyweight: false })
  return <EditorDialog title={exercise ? 'Изменить упражнение' : 'Новое упражнение'} onClose={onClose} onSave={async () => { await healthApi.save('exercises', value, exercise?.id); await onSaved() }} onDelete={exercise ? async () => { await healthApi.remove('exercises', exercise.id); await onSaved() } : undefined}>
    <label>Название<input required maxLength={120} value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></label><label>Вид<select value={value.kind} onChange={e => setValue({ ...value, kind: e.target.value as Exercise['kind'], bodyweight: false })}><option value="strength">Силовое</option><option value="cardio">Кардио</option></select></label>{value.kind === 'strength' && <label className="sp-check"><input type="checkbox" checked={value.bodyweight} onChange={e => setValue({ ...value, bodyweight: e.target.checked })} />С собственным весом</label>}<p className="sp-hint">История тренировок сохраняет исходное название и вид упражнения.</p>
  </EditorDialog>
}
export function SettingsEditor({ settings, onClose, onSaved }: Callbacks & { settings: HealthSettings }) {
  const [value, setValue] = useState(settings)
  return <EditorDialog title="Цели и настройки" onClose={onClose} onSave={async () => { await healthApi.settings(value); await onSaved() }}><p className="sp-hint">Укажите собственные дневные цели. Пустое поле — без цели. Новые цели используются для текущего сравнения, дневник не изменяется.</p><div className="sp-fields">{nutrientKeys.map(key => <label key={key}>{labels[key]} · {key === 'calories' ? 'ккал' : 'г'}<input type="number" min="0.1" max={key === 'calories' ? 50000 : 5000} step="any" value={value.goals[key] ?? ''} onChange={e => setValue({ ...value, goals: { ...value.goals, [key]: e.target.value === '' ? null : e.target.valueAsNumber } })} /></label>)}</div><label>Часовой пояс<input required value={value.timeZone} onChange={e => setValue({ ...value, timeZone: e.target.value })} placeholder="Europe/Moscow" /></label></EditorDialog>
}
export function WellbeingEditor({ date, record, onClose, onSaved }: Callbacks & { date: string; record?: Wellbeing }) {
  const [score, setScore] = useState(record?.score ?? 3)
  const [note, setNote] = useState(record?.note ?? '')
  return <EditorDialog title="Как вы себя чувствуете?" onClose={onClose} onSave={async () => { await healthApi.save('wellbeing', { date, score, note }, record?.id); await onSaved() }} onDelete={record ? async () => { await healthApi.remove('wellbeing', record.id); await onSaved() } : undefined}><p className="sp-hint">Отметка за {date}. Это ваша субъективная оценка.</p><div className="sp-feelings" role="group" aria-label="Самочувствие">{[1, 2, 3, 4, 5].map(n => <button type="button" key={n} aria-pressed={score === n} className={score === n ? 'is-active' : ''} onClick={() => setScore(n)}>{n}<small>{['Плохо', 'Не очень', 'Нормально', 'Хорошо', 'Отлично'][n - 1]}</small></button>)}</div><label>Заметка<textarea maxLength={4000} value={note} onChange={e => setNote(e.target.value)} rows={3} /></label></EditorDialog>
}
