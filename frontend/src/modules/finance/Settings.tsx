import { useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import type { Account, FinanceState } from '../../../../shared/finance'
import { financeRequest } from './api'
import { money, parseMoney } from './money'
import type { FinanceAction } from './types'

type LinkCode = { code: string; expiresAt: string; botUsername?: string }
const deliveryLabels = { pending: 'Ожидает отправки', sending: 'Отправляется', sent: 'Отправлено', failed: 'Не отправлено', uncertain: 'Статус отправки неизвестен' }

export default function Settings({ data, busy, run }: { data: FinanceState; busy: boolean; run: FinanceAction }) {
  const [accountName, setAccountName] = useState('')
  const [initialBalance, setInitialBalance] = useState('0,00')
  const [accountError, setAccountError] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [categoryKind, setCategoryKind] = useState<'income' | 'expense'>('expense')
  const [link, setLink] = useState<LinkCode | null>(null)

  const refreshLinkedTelegram = useEffectEvent(async () => {
    if (busy) return false
    return run('Обновляем привязку Telegram', async () => {}, 'Telegram привязан к финансовому профилю.')
  })

  useEffect(() => {
    if (!link || data.telegram) return
    const expiresIn = Date.parse(link.expiresAt) - Date.now()
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) return
    const controller = new AbortController()
    let timer: number | undefined
    const expiry = window.setTimeout(() => {
      controller.abort()
      window.clearTimeout(timer)
    }, expiresIn)

    async function checkLink() {
      try {
        const state = await financeRequest<FinanceState>('/state', controller.signal)
        if (controller.signal.aborted) return
        if (state.telegram && await refreshLinkedTelegram()) {
          controller.abort()
          setLink(null)
          return
        }
      } catch {
        // A transient poll failure should not interrupt the linking instructions.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(checkLink, 3000)
    }

    timer = window.setTimeout(checkLink, 3000)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      window.clearTimeout(expiry)
    }
  }, [link, data.telegram])

  function addAccount(event: FormEvent) {
    event.preventDefault()
    setAccountError('')
    try {
      const balance = parseMoney(initialBalance, true)
      if (!accountName.trim()) throw new Error('Укажите название счёта.')
      void run('Создаём счёт', async (signal) => {
        await financeRequest('/accounts', signal, 'POST', { name: accountName.trim(), initialBalance: balance })
        if (!signal.aborted) { setAccountName(''); setInitialBalance('0,00') }
      }, 'Счёт создан.')
    } catch (cause) { setAccountError(cause instanceof Error ? cause.message : 'Проверьте данные счёта.') }
  }

  return <>
    <section className="finance-panel"><h2>Счета</h2><p className="finance-caption">Рубли. Начальный остаток задаётся при создании и не считается доходом.</p><div className="finance-settings-list">{data.accounts.map((account) => <AccountRow key={account.id} account={account} run={run} busy={busy} />)}</div><form onSubmit={addAccount} className="finance-inline-form"><label>Название счёта<input value={accountName} onChange={(event) => setAccountName(event.target.value)} maxLength={100} placeholder="Основная карта" disabled={busy} required /></label><label>Начальный остаток, ₽<input value={initialBalance} onChange={(event) => setInitialBalance(event.target.value)} inputMode="decimal" maxLength={24} disabled={busy} required /></label><button className="finance-button finance-primary" type="submit" disabled={busy}>Добавить счёт</button></form>{accountError ? <p className="finance-error" role="alert">{accountError}</p> : null}</section>
    <section className="finance-panel"><h2>Категории</h2><div className="finance-category-tags">{data.categories.map((category) => <span className="finance-badge" key={category.id}>{category.kind === 'income' ? '+' : '−'} {category.name}</span>)}</div><form className="finance-inline-form" onSubmit={(event) => { event.preventDefault(); if (!categoryName.trim()) return; void run('Добавляем категорию', async (signal) => { await financeRequest('/categories', signal, 'POST', { name: categoryName.trim(), kind: categoryKind }); if (!signal.aborted) setCategoryName('') }, 'Категория добавлена.') }}><label>Название категории<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} maxLength={100} disabled={busy} placeholder="Например, транспорт" required /></label><label>Тип<select value={categoryKind} onChange={(event) => setCategoryKind(event.target.value as 'income' | 'expense')} disabled={busy}><option value="expense">Расход</option><option value="income">Доход</option></select></label><button className="finance-button" type="submit" disabled={busy || !categoryName.trim()}>Добавить категорию</button></form></section>
    <section className="finance-panel"><div className="finance-section-heading"><div><h2>Telegram</h2><p className="finance-caption">Операции и чеки из личного чата используют тот же учёт, что и сайт.</p></div><span className="finance-badge">{data.telegram ? 'Привязан' : 'Не привязан'}</span></div>{!data.capabilities.telegram ? <p className="finance-warning">Бот не настроен на сервере. Укажите токен бота в серверном окружении и перезапустите backend.</p> : null}
      {data.telegram ? <><p className="finance-caption">Привязан {new Date(data.telegram.linkedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.</p><button className="finance-button" disabled={busy} onClick={() => { void run('Отключаем Telegram', async (signal) => { await financeRequest('/telegram/link', signal, 'DELETE'); if (!signal.aborted) setLink(null) }, 'Telegram отключён от профиля.') }}>Отключить Telegram</button></> : <><p className="finance-caption">Создайте одноразовый код и отправьте команду привязки боту в личном чате. Код действует 10 минут.</p><button className="finance-button finance-primary" disabled={busy || !data.capabilities.telegram} onClick={() => { void run('Создаём код привязки', async (signal) => { const code = await financeRequest<LinkCode>('/telegram/link', signal, 'POST'); if (!signal.aborted) setLink(code) }) }}>{link ? 'Создать новый код' : 'Создать код привязки'}</button>{link ? <div className="finance-link-code"><span>Отправьте боту команду</span><code>/start {link.code}</code><small>Действует до {new Date(link.expiresAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })} МСК. После привязки статус обновится автоматически.</small>{link.botUsername ? <a href={`https://t.me/${encodeURIComponent(link.botUsername.replace(/^@/, ''))}?start=${encodeURIComponent(link.code)}`} target="_blank" rel="noopener noreferrer">Привязать через @{link.botUsername.replace(/^@/, '')} ↗</a> : null}</div> : null}</>}
      <div className="finance-command-list"><code>/finance</code><span>Сообщение финансовому помощнику</span><code>/balance</code><span>Остатки на счетах</span><code>/expenses</code><span>Расходы за месяц</span><code>/summary</code><span>Сводка котировок</span><code>/cancel</code><span>Отмена текущего черновика</span><code>/help</code><span>Доступные действия</span></div>
    </section>
    <section className="finance-panel"><h2>Доставка ежедневных сводок</h2><p className="finance-caption">В 21:00 по Москве при работающем worker, привязанном Telegram и непустом списке наблюдения.</p>{data.deliveries.length ? <ul className="finance-deliveries">{[...data.deliveries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((delivery) => <li key={delivery.id}><div><strong>{delivery.date}</strong><span className={delivery.status === 'sent' ? 'finance-positive' : delivery.status === 'failed' || delivery.status === 'uncertain' ? 'finance-warning' : ''}>{deliveryLabels[delivery.status]}</span></div><small>Попыток: {delivery.attempts} · {new Date(delivery.updatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</small>{delivery.error ? <p className="finance-warning">{delivery.error}</p> : null}</li>)}</ul> : <p className="finance-empty">Отправок пока нет.</p>}</section>
  </>
}

function AccountRow({ account, busy, run }: { account: Account; busy: boolean; run: FinanceAction }) {
  const [name, setName] = useState(account.name)
  const [editing, setEditing] = useState(false)
  return <div className="finance-account-setting">{editing ? <form onSubmit={(event) => { event.preventDefault(); if (!name.trim()) return; void run('Переименовываем счёт', async (signal) => { await financeRequest(`/accounts/${encodeURIComponent(account.id)}`, signal, 'PATCH', { name: name.trim() }); if (!signal.aborted) setEditing(false) }, 'Название счёта обновлено.') }}><label className="finance-sr-only" htmlFor={`account-name-${account.id}`}>Название счёта</label><input id={`account-name-${account.id}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} disabled={busy} required /><button className="finance-link-button" disabled={busy || !name.trim()} type="submit">Сохранить</button><button className="finance-link-button" onClick={() => { setEditing(false); setName(account.name) }} type="button">Закрыть</button></form> : <><div><strong>{account.name}</strong><small>{money(account.balance)}{account.archived ? ' · архив' : ''}</small></div><div className="finance-row-actions"><button className="finance-link-button" disabled={busy} onClick={() => setEditing(true)}>Переименовать</button><button className="finance-link-button" disabled={busy} onClick={() => { void run(account.archived ? 'Возвращаем счёт' : 'Архивируем счёт', (signal) => financeRequest(`/accounts/${encodeURIComponent(account.id)}`, signal, 'PATCH', { archived: !account.archived }), account.archived ? 'Счёт возвращён из архива.' : 'Счёт перемещён в архив. История и остаток сохранены.') }}>{account.archived ? 'Вернуть' : 'В архив'}</button></div></>}</div>
}
