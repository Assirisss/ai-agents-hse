import { useState, type FormEvent } from 'react'
import type { Account, Category, Draft, DraftInput, Operation, OperationKind } from '../../../../shared/finance'
import { moneyInput, moscowToday, parseMoney } from './money'

type Props = {
  accounts: Account[]
  categories: Category[]
  initial?: Draft | Operation
  mode: 'new' | 'draft' | 'operation'
  disabled: boolean
  onSave: (input: DraftInput, confirm: boolean) => void
  onCancel?: () => void
}

export default function EntryEditor({ accounts, categories, initial, mode, disabled, onSave, onCancel }: Props) {
  const incoming = editorValues(initial, mode, accounts)
  const sourceKey = JSON.stringify([initial?.id, initial?.revision ?? 0, incoming])
  const [values, setValues] = useState(incoming)
  const [baseline, setBaseline] = useState({ key: sourceKey, values: incoming })
  const [error, setError] = useState('')
  const { kind, amount, date, accountId, destinationAccountId, categoryId, description } = values
  const edited = comparable(values) !== comparable(baseline.values)
  const changed = baseline.key !== sourceKey
  const conflict = changed && edited && comparable(values) !== comparable(incoming)
  const dirty = mode === 'draft' && comparable(values) !== comparable(incoming)
  const activeAccounts = accounts.filter((account) => !account.archived || account.id === accountId || account.id === destinationAccountId)

  // Reconcile before rendering children: refreshed data must never share a save handler with stale fields.
  if (changed && !conflict) {
    setValues(incoming)
    setBaseline({ key: sourceKey, values: incoming })
    setError('')
  }
  function setField<K extends keyof EditorValues>(field: K, value: EditorValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
  }
  function reload() {
    setValues(incoming)
    setBaseline({ key: sourceKey, values: incoming })
    setError('')
  }

  function save(confirm: boolean) {
    setError('')
    if (conflict) return
    try {
      const parsed = amount.trim() ? parseMoney(amount) : null
      if (parsed !== null && parsed <= 0) throw new Error('Сумма операции должна быть больше нуля.')
      if (confirm || mode !== 'draft') {
        if (!kind || !parsed || !date || !accountId) throw new Error('Укажите тип, сумму, дату и счёт.')
        if (kind === 'transfer' && !destinationAccountId) throw new Error('Выберите счёт зачисления.')
        if (kind !== 'transfer' && !categoryId) throw new Error('Выберите категорию.')
      }
      if (kind === 'transfer' && accountId && accountId === destinationAccountId) throw new Error('Для перевода выберите два разных счёта.')
      onSave({ kind: kind || null, amount: parsed, date: date || null, accountId: accountId || null, destinationAccountId: kind === 'transfer' ? destinationAccountId || null : null, categoryId: kind === 'transfer' ? null : categoryId || null, description }, confirm)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Проверьте поля операции.') }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save(false)
  }

  return <form className="finance-entry" onSubmit={submit}>
    <fieldset disabled={disabled}>
      <legend className="finance-sr-only">{mode === 'new' ? 'Новая операция' : 'Поля операции'}</legend>
      <div className="finance-fields">
        <label>Тип<select value={kind} onChange={(event) => { setValues((current) => ({ ...current, kind: event.target.value as OperationKind | '', categoryId: '' })) }}><option value="">Выберите тип</option><option value="expense">Расход</option><option value="income">Доход</option><option value="transfer">Перевод</option></select></label>
        <label>Сумма, ₽<input inputMode="decimal" value={amount} onChange={(event) => setField('amount', event.target.value)} maxLength={24} placeholder="0,00" /></label>
        <label>Дата<input type="date" value={date} min="1900-01-01" max="9999-12-31" onChange={(event) => setField('date', event.target.value)} /></label>
        <label>{kind === 'transfer' ? 'Со счёта' : 'Счёт'}<select value={accountId} onChange={(event) => setField('accountId', event.target.value)}><option value="">Выберите счёт</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.archived ? ' (архив)' : ''}</option>)}</select></label>
        {kind === 'transfer' ? <label>На счёт<select value={destinationAccountId} onChange={(event) => setField('destinationAccountId', event.target.value)}><option value="">Выберите счёт</option>{activeAccounts.filter((account) => account.id !== accountId).map((account) => <option key={account.id} value={account.id}>{account.name}{account.archived ? ' (архив)' : ''}</option>)}</select></label> : <label>Категория<select value={categoryId} onChange={(event) => setField('categoryId', event.target.value)}><option value="">Выберите категорию</option>{categories.filter((category) => category.kind === kind).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
        <label className="finance-field-wide">Описание<input value={description} onChange={(event) => setField('description', event.target.value)} maxLength={500} placeholder="Например, продукты на неделю" /></label>
      </div>
      {error ? <p className="finance-error" role="alert">{error}</p> : null}
      {conflict ? <div className="finance-warning" role="alert"><p>Черновик или операция изменились в другом окне или Telegram. Ваши правки остались в форме; перед продолжением загрузите актуальные поля. Несохранённые правки будут заменены.</p><button className="finance-button" type="button" onClick={reload}>Загрузить актуальные поля</button></div> : null}
      {dirty && !conflict ? <p className="finance-caption">Сохраните изменённые поля и проверьте предупреждения перед подтверждением.</p> : null}
      <div className="finance-actions">
        <button className={mode === 'draft' ? 'finance-button' : 'finance-button finance-primary'} type="submit" disabled={conflict}>{mode === 'new' ? 'Создать черновик' : mode === 'draft' ? 'Сохранить поля' : 'Сохранить изменения'}</button>
        {mode === 'draft' ? <button className="finance-button finance-primary" disabled={dirty || conflict} type="button" onClick={() => save(true)}>Подтвердить запись</button> : null}
        {onCancel ? <button className="finance-button finance-quiet" type="button" onClick={onCancel}>{mode === 'draft' ? 'Отменить черновик' : 'Закрыть'}</button> : null}
      </div>
    </fieldset>
  </form>
}

function normalizedAmount(value: string): number | string | null {
  if (!value.trim()) return null
  try { return parseMoney(value) } catch { return value }
}

type EditorValues = { kind: OperationKind | ''; amount: string; date: string; accountId: string; destinationAccountId: string; categoryId: string; description: string }
function editorValues(initial: Draft | Operation | undefined, mode: Props['mode'], accounts: Account[]): EditorValues {
  return {
    kind: initial?.kind ?? (mode === 'new' ? 'expense' : ''), amount: moneyInput(initial?.amount),
    date: initial?.date ?? (mode === 'new' ? moscowToday() : ''),
    accountId: initial?.accountId ?? (mode === 'new' ? accounts.find((account) => !account.archived)?.id ?? '' : ''),
    destinationAccountId: initial?.destinationAccountId ?? '', categoryId: initial?.categoryId ?? '', description: initial?.description ?? '',
  }
}
function comparable(value: EditorValues) {
  return JSON.stringify({ ...value, amount: normalizedAmount(value.amount), destinationAccountId: value.kind === 'transfer' ? value.destinationAccountId : '', categoryId: value.kind === 'transfer' ? '' : value.categoryId })
}
