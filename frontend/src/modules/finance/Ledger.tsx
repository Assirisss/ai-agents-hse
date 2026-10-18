import { useState } from 'react'
import type { AuditEntry, DraftInput, FinanceEvidence, FinanceState, FinanceStats, OperationFilter } from '../../../../shared/finance'
import EntryEditor from './EntryEditor'
import { createDraft, financeRequest, financeUrl, getAudit } from './api'
import { money } from './money'
import type { FinanceAction } from './types'

const kindLabels = { income: 'Доход', expense: 'Расход', transfer: 'Перевод' }

export default function Ledger({ data, stats, from, to, setFrom, setTo, busy, run, onDrafts, onSettings, filter, setFilter, evidence, clearEvidence }: { data: FinanceState; stats: FinanceStats | null; from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void; busy: boolean; run: FinanceAction; onDrafts: () => void; onSettings: () => void; filter: OperationFilter; setFilter: (value: OperationFilter) => void; evidence: FinanceEvidence | null; clearEvidence: () => void }) {
  const [newEntry, setNewEntry] = useState(false)
  const kind = filter.kind ?? 'all'
  const account = filter.accountId ?? 'all'
  const category = filter.categoryId ?? 'all'
  const [showCancelled, setShowCancelled] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [audit, setAudit] = useState<{ id: string; rows: AuditEntry[] } | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const accounts = new Map(data.accounts.map((item) => [item.id, item.name]))
  const categories = new Map(data.categories.map((item) => [item.id, item.name]))
  const operations = data.operations.filter((item) => item.date >= from && item.date <= to && ((showCancelled && !evidence) || item.status === 'posted') && (kind === 'all' || item.kind === kind) && (account === 'all' || item.accountId === account || item.destinationAccountId === account) && (category === 'all' || item.categoryId === category) && (!filter.query || item.description.toLocaleLowerCase('ru-RU').includes(filter.query.toLocaleLowerCase('ru-RU')))).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  const maxExpense = Math.max(1, ...(stats?.expenseByCategory.map((item) => item.amount) ?? []))

  function saveOperation(id: string, input: DraftInput) {
    void run('Сохраняем изменения', async (signal) => {
      await financeRequest(`/operations/${encodeURIComponent(id)}`, signal, 'PATCH', input)
      if (!signal.aborted) setEditingId(null)
    }, 'Изменения сохранены. История операции обновлена.')
  }

  return <>
    <section className="finance-account-grid" aria-label="Остатки на счетах">
      {data.accounts.map((item) => <article className={`finance-account${item.archived ? ' finance-archived' : ''}`} key={item.id}><span>{item.name}{item.archived ? ' · архив' : ''}</span><strong>{money(item.balance)}</strong><small>Начальный остаток {money(item.initialBalance)}</small></article>)}
      {!data.accounts.length ? <div className="finance-empty"><h2>Начните со счёта</h2><p>Добавьте карту, наличные или другой рублёвый счёт и укажите начальный остаток.</p><button className="finance-button finance-primary" onClick={onSettings}>Добавить счёт</button></div> : null}
    </section>
    <div className="finance-section-heading"><h2>Движение денег</h2><button className="finance-button finance-primary" onClick={() => setNewEntry((value) => !value)} disabled={busy || !data.accounts.some((item) => !item.archived)}>{newEntry ? 'Скрыть форму' : '+ Операция'}</button></div>
    {newEntry ? <section className="finance-panel"><h3>Новая операция</h3><p className="finance-caption">Сначала проверите черновик, затем подтвердите запись в учёт.</p><EntryEditor mode="new" accounts={data.accounts} categories={data.categories} disabled={busy} onSave={(input) => { void run('Создаём черновик', async (signal) => { await createDraft(input, signal); if (!signal.aborted) { setNewEntry(false); onDrafts() } }, 'Черновик создан. Проверьте поля и подтвердите запись.') }} /></section> : null}
    {evidence ? <section className="finance-notice"><strong>{evidence.label}</strong><p>В ответе было {evidence.count} операций. Ниже — текущие операции с теми же фильтрами; после изменений состав может отличаться.</p><button className="finance-link-button" onClick={() => { clearEvidence(); setFilter({}) }}>Сбросить фильтры ответа</button></section> : null}
    <div className="finance-filters">
      <label>С даты<input type="date" min="1900-01-01" max="9999-12-31" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>По дату<input type="date" min="1900-01-01" max="9999-12-31" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <label>Тип<select value={kind} onChange={(event) => { clearEvidence(); setFilter({ ...filter, kind: event.target.value === 'all' ? undefined : event.target.value as OperationFilter['kind'] }) }}><option value="all">Все</option><option value="expense">Расходы</option><option value="income">Доходы</option><option value="transfer">Переводы</option></select></label>
      <label>Счёт<select value={account} onChange={(event) => { clearEvidence(); setFilter({ ...filter, accountId: event.target.value === 'all' ? undefined : event.target.value }) }}><option value="all">Все счета</option>{data.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Категория<select value={category} onChange={(event) => { clearEvidence(); setFilter({ ...filter, categoryId: event.target.value === 'all' ? undefined : event.target.value }) }}><option value="all">Все категории</option>{data.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Описание<input value={filter.query ?? ''} placeholder="Поиск в описании" onChange={(event) => { clearEvidence(); setFilter({ ...filter, query: event.target.value || undefined }) }} /></label>
    </div>
    {stats ? <>
      <div className="finance-metrics"><article><span>Доходы</span><strong className="finance-positive">{money(stats.income)}</strong><small>Предыдущий период: {money(stats.previousIncome)}</small></article><article><span>Расходы</span><strong>{money(stats.expense)}</strong><small>Предыдущий период: {money(stats.previousExpense)}</small></article><article><span>Разница</span><strong className={stats.net < 0 ? 'finance-negative' : 'finance-positive'}>{money(stats.net)}</strong><small>Доходы минус расходы</small></article></div>
      <p className="finance-caption">Показатели за {from} — {to} по всем счетам и категориям. Предыдущий период той же длительности. Переводы исключены.</p>
      {stats.expenseByCategory.length ? <section className="finance-panel finance-category-panel"><h3>Расходы по категориям</h3><ul className="finance-category-bars">{stats.expenseByCategory.map((item) => <li key={item.categoryId ?? 'none'}><div><span>{item.name}</span><strong>{money(item.amount)}</strong></div><div className="finance-bar-track" aria-hidden="true"><span style={{ width: `${item.amount / maxExpense * 100}%` }} /></div></li>)}</ul></section> : null}
    </> : null}
    <div className="finance-section-heading"><h3>Операции · {operations.length}</h3><label className="finance-checkbox"><input type="checkbox" checked={showCancelled && !evidence} onChange={(event) => { clearEvidence(); setShowCancelled(event.target.checked) }} />Показывать отменённые</label></div>
    {operations.length ? <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Дата / описание</th><th>Счёт</th><th>Категория</th><th className="finance-number">Сумма</th><th><span className="finance-sr-only">Действия</span></th></tr></thead><tbody>{operations.map((item) => <tr className={item.status === 'cancelled' ? 'finance-cancelled' : ''} key={item.id}><td><span>{item.description || kindLabels[item.kind]}</span><small>{item.date} · {kindLabels[item.kind]}{item.status === 'cancelled' ? ' · отменена' : ''}</small>{item.receiptId ? <button className="finance-link-button" onClick={() => setReceiptId(item.receiptId ?? null)}>Открыть чек</button> : null}</td><td>{accounts.get(item.accountId) || 'Неизвестный счёт'}{item.destinationAccountId ? <small>→ {accounts.get(item.destinationAccountId) || 'Неизвестный счёт'}</small> : null}</td><td>{item.categoryId ? categories.get(item.categoryId) || 'Категория удалена' : '—'}</td><td className={`finance-number ${item.kind === 'income' ? 'finance-positive' : ''}`}>{item.kind === 'expense' ? '−' : item.kind === 'income' ? '+' : ''}{money(item.amount)}</td><td><div className="finance-row-actions">{item.status === 'posted' ? <button className="finance-link-button" disabled={busy} onClick={() => { setEditingId(editingId === item.id ? null : item.id); setCancelId(null) }}>Изменить</button> : null}<button className="finance-link-button" disabled={busy} onClick={() => { void run('Загружаем историю', async (signal) => { const rows = await getAudit(item.id, signal); if (!signal.aborted) setAudit({ id: item.id, rows }) }) }}>История</button></div></td></tr>)}</tbody></table></div> : <p className="finance-empty">За выбранный период и с этими фильтрами операций нет.</p>}
    {receiptId ? <section className="finance-panel"><div className="finance-section-heading"><h3>Чек операции</h3><button className="finance-link-button" onClick={() => setReceiptId(null)}>Закрыть</button></div><a href={financeUrl(`/receipts/${encodeURIComponent(receiptId)}/image`)} target="_blank" rel="noopener noreferrer"><img className="finance-receipt-image" src={financeUrl(`/receipts/${encodeURIComponent(receiptId)}/image`)} alt="Оригинал чека операции" /></a></section> : null}
    {editingId ? <section className="finance-panel"><h3>Изменение операции</h3><p className="finance-caption">Изменения пересчитают остатки и сохранятся в истории.</p><EntryEditor key={editingId} mode="operation" initial={data.operations.find((item) => item.id === editingId)} accounts={data.accounts} categories={data.categories} disabled={busy} onSave={(input) => saveOperation(editingId, input)} onCancel={() => setEditingId(null)} /><div className="finance-danger-zone">{cancelId === editingId ? <><span>Отменить запись и исключить её из расчётов?</span><button className="finance-button finance-danger" disabled={busy} onClick={() => { void run('Отменяем операцию', async (signal) => { await financeRequest(`/operations/${encodeURIComponent(editingId)}/cancel`, signal, 'POST'); if (!signal.aborted) { setEditingId(null); setCancelId(null) } }, 'Операция отменена. Остатки пересчитаны.') }}>Да, отменить операцию</button><button className="finance-button finance-quiet" onClick={() => setCancelId(null)}>Оставить</button></> : <button className="finance-link-button finance-negative" disabled={busy} onClick={() => setCancelId(editingId)}>Отменить операцию</button>}</div></section> : null}
    {audit ? <section className="finance-panel"><div className="finance-section-heading"><h3>История изменений</h3><button className="finance-link-button" onClick={() => setAudit(null)}>Закрыть</button></div>{audit.rows.length ? <ol className="finance-audit-list">{audit.rows.map((entry) => <li key={entry.id}><span>{auditLabel(entry.action)} · {new Date(entry.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</span><details><summary>До и после</summary><div className="finance-audit-values"><div><small>До</small><AuditSnapshot value={entry.before} accounts={accounts} categories={categories} /></div><div><small>После</small><AuditSnapshot value={entry.after} accounts={accounts} categories={categories} /></div></div></details></li>)}</ol> : <p className="finance-caption">История пуста.</p>}</section> : null}
  </>
}

function auditLabel(action: string) {
  const labels: Record<string, string> = { create: 'Создана', confirm: 'Подтверждена', update: 'Изменена', cancel: 'Отменена', created: 'Создана', confirmed: 'Подтверждена', updated: 'Изменена', cancelled: 'Отменена' }
  return labels[action.split('.').at(-1) ?? ''] || 'Изменение записи'
}

function AuditSnapshot({ value, accounts, categories }: { value: unknown; accounts: Map<string, string>; categories: Map<string, string> }) {
  if (!value || typeof value !== 'object') return <p className="finance-audit-snapshot">Записи ещё не было</p>
  const item = value as Record<string, unknown>
  const rows: [string, string][] = []
  if (item.kind === 'income' || item.kind === 'expense' || item.kind === 'transfer') rows.push(['Тип', kindLabels[item.kind]])
  if (typeof item.amount === 'number' && Number.isSafeInteger(item.amount)) rows.push(['Сумма', money(item.amount)])
  if (typeof item.date === 'string') rows.push(['Дата', item.date])
  if (typeof item.accountId === 'string') rows.push(['Счёт', accounts.get(item.accountId) ?? 'Неизвестный счёт'])
  if (typeof item.destinationAccountId === 'string') rows.push(['Зачисление', accounts.get(item.destinationAccountId) ?? 'Неизвестный счёт'])
  if (typeof item.categoryId === 'string') rows.push(['Категория', categories.get(item.categoryId) ?? 'Неизвестная категория'])
  if (typeof item.description === 'string' && item.description) rows.push(['Описание', item.description])
  if (item.status === 'posted' || item.status === 'cancelled') rows.push(['Статус', item.status === 'posted' ? 'Записана' : 'Отменена'])
  return <dl className="finance-audit-snapshot">{rows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
}
