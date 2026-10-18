import { useEffect, useState, type FormEvent } from 'react'
import type { FinanceState, Payment, PaymentInput } from '../../../../shared/finance'
import { financeRequest } from './api'
import { money, moscowToday, parseMoney } from './money'
import type { FinanceAction } from './types'

export default function Payments({ data, busy, run, onDrafts }: { data: FinanceState; busy: boolean; run: FinanceAction; onDrafts: () => void }) {
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [formError, setFormError] = useState('')
  const [title, setTitle] = useState(''), [amount, setAmount] = useState(''), [dueDate, setDueDate] = useState(moscowToday), [time, setTime] = useState('09:00')
  const [repeat, setRepeat] = useState('once'), [accountId, setAccountId] = useState(''), [categoryId, setCategoryId] = useState('')
  const [cancelId, setCancelId] = useState<string | null>(null), [showCancelled, setShowCancelled] = useState(false), [refresh, setRefresh] = useState(0)
  const accounts = new Map(data.accounts.map((account) => [account.id, account.name]))
  const categories = new Map(data.categories.map((category) => [category.id, category.name]))
  const visible = payments.filter((item) => showCancelled || item.status === 'active').sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.time.localeCompare(b.time))

  useEffect(() => {
    const abort = new AbortController()
    let alive = true
    const timeout = window.setTimeout(() => abort.abort(), 15000)
    Promise.resolve().then(async () => {
      if (abort.signal.aborted) return
      setLoading(true); setError('')
      const rows = await financeRequest<Payment[]>('/payments', abort.signal)
      if (alive && !abort.signal.aborted) setPayments(rows)
    }).catch((cause) => { if (alive) setError(abort.signal.aborted ? 'Время загрузки платежей истекло. Повторите обновление.' : cause instanceof Error ? cause.message : 'Не удалось загрузить платежи.') })
      .finally(() => { window.clearTimeout(timeout); if (alive) setLoading(false) })
    return () => { alive = false; abort.abort(); window.clearTimeout(timeout) }
  }, [data, refresh])

  function create(event: FormEvent) {
    event.preventDefault(); setFormError('')
    try {
      if (!title.trim()) throw new Error('Укажите название платежа.')
      const kopecks = amount.trim() ? parseMoney(amount) : null
      if (kopecks !== null && kopecks <= 0) throw new Error('Сумма должна быть больше нуля или оставаться пустой.')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Укажите дату и время напоминания.')
      const rrule = repeat === 'monthly' ? `FREQ=MONTHLY;BYMONTHDAY=${Number(dueDate.slice(8))}` : repeat === 'weekly' ? `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${dueDate}T12:00:00Z`).getUTCDay()]}` : null
      const input: PaymentInput = { title: title.trim(), amount: kopecks, dueDate, time, rrule, accountId: accountId || null, categoryId: categoryId || null }
      void run('Создаём напоминание о платеже', async (signal) => {
        await financeRequest<Payment>('/payments', signal, 'POST', input)
        if (!signal.aborted) { setTitle(''); setAmount(''); setCancelId(null); setRefresh((value) => value + 1) }
      }, 'Напоминание создано. Баланс не изменён; факт оплаты записывается отдельно.')
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Проверьте поля платежа.') }
  }

  return <>
    <section className="finance-panel"><h2>Напоминания о платежах</h2><p className="finance-caption">Напоминание не является расходом и не меняет баланс. После оплаты создайте и подтвердите отдельную операцию.</p><p className="finance-caption">Время — московское. Сроки видны в общем календаре. Для сообщений нужны работающий backend и финансовая привязка Telegram.</p>{!data.telegram ? <p className="finance-warning">Telegram не привязан к финансовому профилю. Напоминания доступны в календаре; привяжите бота в настройках для сообщений в Telegram.</p> : null}
      <form onSubmit={create}><fieldset disabled={busy}><div className="finance-fields"><label className="finance-field-wide">Название<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} placeholder="Оплатить аренду" required /></label><label>Сумма, ₽ · необязательно<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" maxLength={24} placeholder="Уточню при оплате" /></label><label>Первый срок<input type="date" min="1900-01-01" max="9999-12-31" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label><label>Время, МСК<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label><label>Повтор<select value={repeat} onChange={(event) => setRepeat(event.target.value)}><option value="once">Однократно</option><option value="weekly">Каждую неделю</option><option value="monthly">Каждый месяц</option></select></label><label>Счёт · необязательно<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Уточнить при оплате</option>{data.accounts.filter((account) => !account.archived).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>Категория · необязательно<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Уточнить при оплате</option>{data.categories.filter((category) => category.kind === 'expense').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label></div>{repeat === 'monthly' && Number(dueDate.slice(8)) >= 29 ? <p className="finance-warning">Месяцы, в которых нет выбранного числа, будут пропущены.</p> : null}{formError ? <p className="finance-error" role="alert">{formError}</p> : null}<button className="finance-button finance-primary" type="submit" disabled={busy || !title.trim()}>Создать напоминание</button></fieldset></form>
    </section>
    <div className="finance-section-heading"><h3>Платежи · {visible.length}</h3><div className="finance-row-actions"><label className="finance-checkbox"><input type="checkbox" checked={showCancelled} onChange={(event) => setShowCancelled(event.target.checked)} />Показывать отменённые</label><button className="finance-link-button" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>Обновить</button></div></div>
    {loading ? <p className="finance-caption" role="status">Загружаем платежи…</p> : null}{error ? <p className="finance-error" role="alert">{error}</p> : null}
    {visible.map((item) => <article className={`finance-panel${item.status === 'cancelled' ? ' finance-cancelled' : ''}`} key={item.id}><div className="finance-section-heading"><h3>{item.title}</h3><strong>{item.amount === null ? 'Сумма не задана' : money(item.amount)}</strong></div><p className="finance-caption">{item.dueDate} · {item.time} МСК · {item.rrule ? item.rrule.includes('MONTHLY') ? 'Ежемесячно' : item.rrule.includes('WEEKLY') ? 'Еженедельно' : 'Повторяется' : 'Однократно'}{item.status === 'cancelled' ? ' · отменено' : ''}</p><p className="finance-caption">{item.accountId ? accounts.get(item.accountId) || 'Счёт недоступен' : 'Счёт уточняется'} · {item.categoryId ? categories.get(item.categoryId) || 'Категория недоступна' : 'Категория уточняется'}</p>{item.syncStatus !== 'synced' ? <p className="finance-warning">{item.syncStatus === 'error' ? 'Не удалось связать с календарём.' : 'Связь с календарём ожидает обработки.'}{item.error ? ` ${item.error}` : ''} Обновите список для проверки.</p> : <span className="finance-badge">Связано с календарём</span>}
      {item.status === 'active' ? <div className="finance-actions"><button className="finance-button finance-primary" disabled={busy} onClick={() => { void run('Создаём черновик оплаты', async (signal) => { await financeRequest(`/payments/${encodeURIComponent(item.id)}/draft`, signal, 'POST'); if (!signal.aborted) onDrafts() }, 'Черновик оплаты создан. Проверьте дату и сумму, затем подтвердите запись.') }}>Записать фактическую оплату</button>{cancelId === item.id ? <><span className="finance-caption">Отменить напоминание и его повторы?</span><button className="finance-button finance-danger" disabled={busy} onClick={() => { void run('Отменяем напоминание', async (signal) => { await financeRequest(`/payments/${encodeURIComponent(item.id)}/cancel`, signal, 'POST'); if (!signal.aborted) { setCancelId(null); setRefresh((value) => value + 1) } }, 'Напоминание отменено. Операции учёта не изменились.') }}>Да, отменить</button><button className="finance-button finance-quiet" disabled={busy} onClick={() => setCancelId(null)}>Оставить</button></> : <button className="finance-link-button" disabled={busy} onClick={() => setCancelId(item.id)}>Отменить напоминание</button>}</div> : null}</article>)}
    {!loading && !error && !visible.length ? <p className="finance-empty">Напоминаний пока нет. Добавьте аренду, подписку или другой платёж с известным сроком.</p> : null}
  </>
}
