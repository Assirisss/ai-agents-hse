import { useEffect, useRef, useState } from 'react'
import type { Meal, MealItem, MealKind, Product } from '../../../../shared/health'
import { mealNutrition } from '../../../../shared/health-math.mts'
import { healthApi } from './api'
import { ProductFields } from './CatalogEditors'
import { EditorDialog, NutritionCards } from './ui'
import { blankProduct, errorMessage, fmt, mealLabels, uid } from './format'

export default function MealEditor({ meal, date, products, onClose, onSaved }: { meal: Meal | null; date: string; products: Product[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(meal?.name ?? '')
  const [day, setDay] = useState(meal?.date ?? date)
  const [kind, setKind] = useState<MealKind>(meal?.kind ?? 'breakfast')
  const [note, setNote] = useState(meal?.note ?? '')
  const [items, setItems] = useState<MealItem[]>(() => structuredClone(meal?.items ?? []))
  const [catalog, setCatalog] = useState(products)
  const [chosen, setChosen] = useState(products[0]?.id ?? '')
  const [grams, setGrams] = useState(100)
  const [photo, setPhoto] = useState<string | null | undefined>()
  const [reading, setReading] = useState(false)
  const photoRequest = useRef(0)
  const [error, setError] = useState('')
  const [newProduct, setNewProduct] = useState<ReturnType<typeof blankProduct> | null>(null)
  const [savingProduct, setSavingProduct] = useState(false)
  useEffect(() => () => { photoRequest.current++ }, [])
  const preview = photo === undefined ? (meal?.hasPhoto ? healthApi.photo(meal.id, meal.photoVersion) : null) : photo
  async function readPhoto(file?: File) {
    if (!file) return
    const token = ++photoRequest.current
    setError(''); setReading(true)
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) throw new Error('Выберите JPEG, PNG или WebP до 6 МиБ')
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Не удалось прочитать файл')); reader.readAsDataURL(file) })
      if (token === photoRequest.current) setPhoto(data)
    } catch (cause) { if (token === photoRequest.current) setError(errorMessage(cause)) }
    finally { if (token === photoRequest.current) setReading(false) }
  }
  function add() {
    const product = catalog.find(item => item.id === chosen)
    if (!product || !Number.isFinite(grams) || grams <= 0 || grams > 100000) { setError('Выберите продукт и укажите положительную массу до 100 000 г'); return }
    setItems(current => [...current, { id: uid(), productId: product.id, grams, product }]); setError('')
  }
  async function saveProduct() {
    if (!newProduct || savingProduct) return
    if (!newProduct.name.trim() || Object.values(newProduct.per100).some(n => !Number.isFinite(n) || n < 0)) { setError('Заполните название и КБЖУ продукта'); return }
    setSavingProduct(true); setError('')
    try {
      const product = await healthApi.save<Product>('products', newProduct)
      setCatalog(current => [...current, product]); setChosen(product.id); setNewProduct(null)
    } catch (cause) { setError(errorMessage(cause)) } finally { setSavingProduct(false) }
  }
  return <EditorDialog wide title={meal ? 'Изменить приём пищи' : 'Добавить еду'} onClose={onClose} onSave={async () => {
    if (reading || savingProduct) throw new Error('Дождитесь загрузки фотографии или сохранения продукта')
    if (newProduct) throw new Error('Сохраните новый продукт или закройте его форму')
    if (!items.length) throw new Error('Добавьте хотя бы один продукт')
    await healthApi.save('meals', { name: name.trim() || mealLabels[kind], date: day, kind, note, items, photo }, meal?.id); await onSaved()
  }} onDelete={meal ? async () => { await healthApi.remove('meals', meal.id); await onSaved() } : undefined}>
    <div className="sp-fields"><label>Дата<input type="date" required value={day} onChange={e => setDay(e.target.value)} /></label><label>Приём пищи<select value={kind} onChange={e => setKind(e.target.value as MealKind)}>{Object.entries(mealLabels).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label></div><label>Название · необязательно<input maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder={mealLabels[kind]} /></label>
    <section className="sp-photo-section">{preview ? <img src={preview} alt="Фото приёма пищи" /> : <div className="sp-photo-placeholder">Фото блюда</div>}<div><h3>Добавьте фотографию</h3><p className="sp-hint">Фото сохранится в дневнике. Распознавание пока недоступно — укажите продукты и массу вручную.</p><label className="sp-file">{reading ? 'Чтение…' : preview ? 'Заменить фото' : 'Выбрать фото'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={reading} onChange={e => { void readPhoto(e.target.files?.[0]); e.target.value = '' }} /></label>{preview && <button className="sp-text" type="button" onClick={() => { photoRequest.current++; setReading(false); setPhoto(null) }}>Убрать фото</button>}<p className="sp-hint">JPEG, PNG, WebP · до 6 МиБ</p></div></section>
    <div className="sp-section-title"><h3>Состав</h3><span>{items.length} продуктов</span></div>
    {items.map(item => <div key={item.id} className="sp-meal-item"><div><strong>{item.product.name}</strong><small>{item.product.brand || 'Свой продукт'} · {fmt(item.product.per100.calories)} ккал / 100 г</small></div><label>Масса, г<input aria-label={`Масса: ${item.product.name}`} type="number" required min="0.01" max="100000" step="any" value={Number.isNaN(item.grams) ? '' : item.grams} onChange={e => setItems(current => current.map(row => row.id === item.id ? { ...row, grams: e.target.valueAsNumber } : row))} /></label><button type="button" className="sp-text" aria-label={`Убрать ${item.product.name}`} onClick={() => setItems(current => current.filter(row => row.id !== item.id))}>×</button></div>)}
    <div className="sp-inline"><label className="sp-grow">Продукт<select value={chosen} onChange={e => setChosen(e.target.value)}>{!catalog.length && <option value="">Создайте первый продукт</option>}{catalog.map(product => <option key={product.id} value={product.id}>{product.name}{product.brand ? ` · ${product.brand}` : ''}</option>)}</select></label><label className="sp-small-field">Масса, г<input type="number" min="0.01" max="100000" step="any" value={Number.isNaN(grams) ? '' : grams} onChange={e => setGrams(e.target.valueAsNumber)} /></label><button type="button" className="sp-secondary" disabled={!catalog.length} onClick={add}>Добавить</button></div>
    {!newProduct ? <button type="button" className="sp-text" onClick={() => setNewProduct(blankProduct())}>+ Создать продукт</button> : <section className="sp-exercise-block"><h3>Новый продукт</h3><fieldset disabled={savingProduct}><ProductFields value={newProduct} onChange={setNewProduct} /></fieldset><div className="sp-inline"><button type="button" className="sp-secondary" disabled={savingProduct} onClick={() => void saveProduct()}>{savingProduct ? 'Сохранение…' : 'Сохранить продукт'}</button><button type="button" className="sp-text" disabled={savingProduct} onClick={() => setNewProduct(null)}>Отмена</button></div></section>}
    {error && <p className="sp-error" role="alert">{error}</p>}
    <div className="sp-meal-totals"><h3>Итого за приём пищи</h3><NutritionCards value={mealNutrition({ items: items.map(item => ({ ...item, grams: Number.isFinite(item.grams) ? item.grams : 0 })) })} /></div>
    <label>Заметка<textarea maxLength={4000} rows={2} value={note} onChange={e => setNote(e.target.value)} /></label>
  </EditorDialog>
}
