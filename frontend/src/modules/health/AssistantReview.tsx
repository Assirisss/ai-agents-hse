import { useState } from 'react'
import type { Exercise, HealthAiFood, HealthAiWorkout, MealItem, Product, Workout } from '../../../../shared/health'
import { healthApi } from './api'
import { ProductFields } from './CatalogEditors'
import { errorMessage, fmt, uid } from './format'

export function WorkoutReview({ draft, date, note, exercises, onCatalog, onOpen }: { draft: HealthAiWorkout; date: string; note: string; exercises: Exercise[]; onCatalog: (value: Exercise[]) => void; onOpen: (value: Workout) => void }) {
  const [rows, setRows] = useState(() => draft.entries.map(entry => ({ ...entry, exerciseId: entry.exerciseId ?? '' })))
  const [creating, setCreating] = useState<number | null>(null)
  const [exerciseName, setExerciseName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = rows.length > 0 && rows.every(row => exercises.some(item => item.id === row.exerciseId))
  async function createExercise() {
    if (creating === null || busy) return
    setBusy(true); setError('')
    try {
      const row = rows[creating]
      const exercise = await healthApi.save<Exercise>('exercises', { name: exerciseName, kind: row.kind, bodyweight: row.bodyweight })
      onCatalog([...exercises, exercise])
      setRows(current => current.map((item, index) => index === creating ? { ...item, exerciseId: exercise.id } : item)); setCreating(null)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="sp-stack"><h3>{draft.name}</h3><p className="sp-hint">Сопоставьте упражнения со справочником. В форме тренировки проверьте числа и заполните пропуски.</p>
    <fieldset disabled={busy} className="sp-stack">{rows.map((row, index) => <section className="sp-exercise-block" key={index}><div className="sp-section-title"><h3>{row.name}</h3><button type="button" className="sp-text" onClick={() => { setRows(items => items.filter((_, i) => i !== index)); setCreating(null) }}>Убрать</button></div>
      <p className="sp-hint">{row.kind === 'strength' ? row.sets.map(set => `${set.reps ?? '?'} повт. × ${set.weight ?? '?'} кг`).join(' · ') || 'Подходы не указаны' : `${row.minutes ?? '?'} мин${row.distanceKm === null ? '' : ` · ${row.distanceKm} км`}`}</p>
      <label>Упражнение в справочнике<select value={row.exerciseId} onChange={event => setRows(items => items.map((item, i) => i === index ? { ...item, exerciseId: event.target.value } : item))}><option value="">Выберите упражнение</option>{exercises.filter(exercise => exercise.kind === row.kind && exercise.bodyweight === row.bodyweight).map(exercise => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label>
      {creating === index ? <div className="sp-stack"><label>Название нового упражнения<input maxLength={120} value={exerciseName} onChange={e => setExerciseName(e.target.value)} /></label><p className="sp-hint">{row.kind === 'cardio' ? 'Кардио' : row.bodyweight ? 'Силовое с собственным весом' : 'Силовое с отягощением'}</p><div className="sp-inline"><button type="button" className="sp-secondary" disabled={!exerciseName.trim()} onClick={() => void createExercise()}>Сохранить в справочник</button><button type="button" className="sp-text" onClick={() => setCreating(null)}>Отмена</button></div></div> : <button type="button" className="sp-text" onClick={() => { setCreating(index); setExerciseName(row.name) }}>+ Создать это упражнение</button>}
    </section>)}</fieldset>
    {error && <p className="sp-error" role="alert">{error}</p>}
    <button type="button" className="sp-primary" disabled={!ready || busy} onClick={() => onOpen({ id: uid(), date, name: draft.name, location: draft.location, note, entries: rows.map(row => {
      const exercise = exercises.find(item => item.id === row.exerciseId)!
      return { id: uid(), exerciseId: exercise.id, exercise, sets: row.kind === 'cardio' ? [] : (row.sets.length ? row.sets : [{ reps: null, weight: null }]).map(set => ({ reps: set.reps ?? NaN, weight: set.weight ?? NaN })), minutes: row.minutes, distanceKm: row.distanceKm }
    }) })}>Проверить и записать тренировку</button>
  </div>
}

export function FoodReview({ draft, products, onCatalog, onOpen }: { draft: HealthAiFood; products: Product[]; onCatalog: (value: Product[]) => void; onOpen: (items: MealItem[]) => void }) {
  const [rows, setRows] = useState(() => draft.components.map(item => ({ ...item, productId: item.productId ?? '', grams: '' })))
  const [newProduct, setNewProduct] = useState<Omit<Product, 'id'> | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = rows.length > 0 && rows.every(row => products.some(product => product.id === row.productId) && Number(row.grams) > 0 && Number(row.grams) <= 100000)
  async function saveProduct() {
    if (!newProduct || !confirmed || busy) return
    if (Object.values(newProduct.per100).some(value => !Number.isFinite(value))) { setError('Заполните все значения КБЖУ'); return }
    setBusy(true); setError('')
    try {
      const product = await healthApi.save<Product>('products', newProduct)
      onCatalog([...products, product]); setNewProduct(null); setConfirmed(false)
      if (!rows.length) setRows([{ name: product.name, productId: product.id, estimatedGrams: null, grams: '' }])
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="sp-stack"><h3>{draft.name}</h3><p className="sp-hint">Проверьте продукты и массу порции. Оценка модели по фото приблизительная; КБЖУ рассчитывается из выбранных продуктов.</p>
    <fieldset disabled={busy} className="sp-stack">{rows.map((row, index) => <section className="sp-exercise-block" key={index}><div className="sp-section-title"><h3>{row.name}</h3><button type="button" className="sp-text" onClick={() => setRows(items => items.filter((_, i) => i !== index))}>Убрать</button></div><div className="sp-fields">
      <label>Продукт из справочника<select value={row.productId} onChange={e => setRows(items => items.map((item, i) => i === index ? { ...item, productId: e.target.value } : item))}><option value="">Выберите продукт</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}{product.brand ? ` · ${product.brand}` : ''}</option>)}</select></label>
      <label>Подтверждённая масса, г<input type="number" min="0.01" max="100000" step="any" value={row.grams} onChange={e => setRows(items => items.map((item, i) => i === index ? { ...item, grams: e.target.value } : item))} /></label>
      </div>{row.estimatedGrams !== null && <p className="sp-hint">Предположение модели: около {fmt(row.estimatedGrams)} г. <button type="button" className="sp-text" onClick={() => setRows(items => items.map((item, i) => i === index ? { ...item, grams: String(row.estimatedGrams) } : item))}>Использовать эту оценку</button></p>}</section>)}
      <button type="button" className="sp-text" onClick={() => setRows(items => [...items, { name: 'Ещё один продукт', productId: '', estimatedGrams: null, grams: '' }])}>+ Добавить компонент</button>
      {newProduct ? <section className="sp-exercise-block sp-stack"><ProductFields value={newProduct} onChange={value => { setNewProduct(value); setConfirmed(false) }} /><label className="sp-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Я проверил название и все значения на 100 г</label><div className="sp-inline"><button type="button" className="sp-secondary" disabled={!confirmed} onClick={() => void saveProduct()}>Сохранить продукт</button><button type="button" className="sp-text" onClick={() => setNewProduct(null)}>Отмена</button></div></section> : <div className="sp-inline">{draft.label && <button type="button" className="sp-secondary" onClick={() => { setNewProduct(draft.label); setConfirmed(false) }}>Проверить данные с этикетки</button>}<button type="button" className="sp-text" onClick={() => { setNewProduct({ name: '', brand: '', per100: { calories: NaN, protein: NaN, fat: NaN, carbs: NaN } }); setConfirmed(false) }}>+ Создать продукт вручную</button></div>}
    </fieldset>
    {error && <p className="sp-error" role="alert">{error}</p>}
    <button type="button" className="sp-primary" disabled={!ready || busy || newProduct !== null} onClick={() => onOpen(rows.map(row => ({ id: uid(), productId: row.productId, product: products.find(product => product.id === row.productId)!, grams: Number(row.grams) })))}>Проверить и записать еду</button>
  </div>
}
