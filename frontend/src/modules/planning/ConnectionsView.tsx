import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { CalendarAccount, GoogleConfig, SyncReport, TelegramLink, TelegramStatus } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import yandexStep1 from './assets/yandex-step-1.png'
import yandexStep2 from './assets/yandex-step-2.png'
import yandexStep3 from './assets/yandex-step-3.png'

const statusBadge = (account: CalendarAccount) => account.status === 'ok'
  ? <span className="pl-badge green">работает</span>
  : account.status === 'needs_auth' ? <span className="pl-badge orange">нужно переподключить</span> : <span className="pl-badge red">ошибка</span>
const when = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'ещё не было'

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return <button type="button" className="pl-button secondary small" onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}>{copied ? 'Скопировано' : 'Копировать'}</button>
}

function AccountCard({ account, onChange }: { account: CalendarAccount; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true); setMessage('')
    try { await work(); if (done) setMessage(done); onChange() } catch (cause) { setMessage(errorText(cause)) } finally { setBusy(false) }
  }
  return (
    <div className="pl-account">
      <div className="pl-spread">
        <div className="pl-row"><strong>{account.label}</strong>{statusBadge(account)}</div>
        <div className="pl-row">
          <button type="button" className="pl-button secondary small" disabled={busy} onClick={() => run(async () => {
            const reports = await planningApi.syncAccount(account.id)
            const total = reports.reduce((sum, report) => sum + report.pulled.created + report.pulled.updated + report.pulled.deleted + report.pushed.created + report.pushed.updated + report.pushed.deleted, 0)
            setMessage(reports.length ? `Готово: изменений ${total}, конфликтов ${reports.reduce((sum, report) => sum + report.conflicts.length, 0)}` : 'Включите хотя бы один календарь')
          })}>{busy ? 'Синхронизирую…' : 'Синхронизировать'}</button>
          <button type="button" className="pl-button secondary small" disabled={busy} onClick={() => run(() => planningApi.refreshCalendars(account.id), 'Список календарей обновлён')}>Обновить список</button>
          <button type="button" className="pl-button danger small" disabled={busy} onClick={() => window.confirm(`Отключить ${account.label}? Импортированные события исчезнут, созданные здесь останутся локально.`) && run(() => planningApi.deleteAccount(account.id))}>Отключить</button>
        </div>
      </div>
      <p className="pl-caption" style={{ marginTop: 6 }}>Последняя синхронизация: {when(account.lastSyncAt)}{account.lastError ? ` · ${account.lastError}` : ''}</p>
      <ul className="pl-calendar-list">
        {account.calendars.map((calendar) => (
          <li key={calendar.id}>
            <span className="pl-row"><span className="pl-dot" style={{ background: calendar.color }} />{calendar.name}{calendar.writable ? null : <span className="pl-badge">только чтение</span>}</span>
            <label className="pl-check"><input type="checkbox" checked={calendar.enabled} disabled={busy} onChange={(event) => run(() => planningApi.setCalendarEnabled(calendar.id, event.target.checked))} />синхронизировать</label>
          </li>
        ))}
      </ul>
      {message ? <p className="pl-caption" style={{ marginTop: 8 }}>{message}</p> : null}
    </div>
  )
}

function GoogleCard({ accounts, onChange }: { accounts: CalendarAccount[]; onChange: () => void }) {
  const [config, setConfig] = useState<GoogleConfig | null>(null)
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { planningApi.googleConfig().then(setConfig).catch((cause) => setError(errorText(cause))) }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try { setConfig(await planningApi.saveGoogleConfig({ clientId, clientSecret })); setEditing(false); setClientSecret('') } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function connect() {
    setBusy(true); setError('')
    try { window.location.assign((await planningApi.googleStart()).url) } catch (cause) { setError(errorText(cause)); setBusy(false) }
  }
  const showForm = !config?.configured || editing
  return (
    <article className="pl-card">
      <div className="pl-spread">
        <div className="pl-provider"><span className="pl-provider-logo google">G</span><div><h3>Google Календарь</h3><p className="pl-caption">Двусторонняя синхронизация через Google Calendar API и OAuth</p></div></div>
        {config?.configured && !editing ? <div className="pl-row"><button type="button" className="pl-button" onClick={connect} disabled={busy}>{accounts.length ? 'Подключить ещё аккаунт' : 'Войти через Google'}</button><button type="button" className="pl-button secondary small" onClick={() => setEditing(true)}>Изменить ключи</button></div> : null}
      </div>
      {showForm && config ? (
        <>
          <ol className="pl-steps">
            <li>Откройте <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> и создайте проект (любое название).</li>
            <li>Включите <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer">Google Calendar API</a> кнопкой «Enable».</li>
            <li>Откройте <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener noreferrer">Google Auth Platform</a> → «Get started»: название приложения, ваша почта, тип аудитории <b>External</b>. Затем в разделе «Audience» → «Test users» добавьте свой Gmail.</li>
            <li>В разделе <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Clients</a> → «Create client» → тип <b>Web application</b>. В «Authorized redirect URIs» добавьте адрес: <span className="pl-row" style={{ display: 'inline-flex', marginTop: 4 }}><code>{config.redirectUri}</code><Copy value={config.redirectUri} /></span></li>
            <li>Скопируйте Client ID и Client Secret в поля ниже, сохраните и нажмите «Войти через Google». Google предупредит, что приложение не проверено — для тестового режима это нормально: «Продолжить».</li>
          </ol>
          <p className="pl-caption" style={{ marginTop: 8 }}>В тестовом режиме Google выдаёт доступ на 7 дней — затем аккаунт получит статус «нужно переподключить», достаточно снова нажать «Войти через Google». Секрет хранится только на вашем backend в зашифрованном виде.</p>
          <form className="pl-stack" style={{ marginTop: 12 }} onSubmit={save}>
            <div className="pl-grid-2">
              <label className="pl-field">Client ID<input required value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="123…apps.googleusercontent.com" autoComplete="off" /></label>
              <label className="pl-field">Client Secret<input required type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="GOCSPX-…" autoComplete="off" /></label>
            </div>
            <div className="pl-form-actions">{editing ? <button type="button" className="pl-button secondary" onClick={() => setEditing(false)}>Отмена</button> : null}<button type="submit" className="pl-button" disabled={busy}>Сохранить ключи</button></div>
          </form>
        </>
      ) : config ? <p className="pl-caption" style={{ marginTop: 8 }}>Ключи сохранены ({config.clientIdPreview}). Адрес возврата: <code className="pl-code">{config.redirectUri}</code></p> : null}
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      {accounts.map((account) => <AccountCard key={account.id} account={account} onChange={onChange} />)}
    </article>
  )
}

function YandexCard({ accounts, onChange }: { accounts: CalendarAccount[]; onChange: () => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [calendarUrl, setCalendarUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!accounts.length)
  async function connect(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try { await planningApi.connectYandex({ login, password, ...(calendarUrl.trim() ? { calendarUrl: calendarUrl.trim() } : {}) }); setPassword(''); setOpen(false); onChange() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return (
    <article className="pl-card">
      <div className="pl-spread">
        <div className="pl-provider"><span className="pl-provider-logo yandex">Я</span><div><h3>Яндекс Календарь</h3><p className="pl-caption">Двусторонняя синхронизация по CalDAV с паролем приложения</p></div></div>
        {!open ? <button type="button" className="pl-button secondary" onClick={() => setOpen(true)}>{accounts.length ? 'Подключить ещё' : 'Подключить'}</button> : null}
      </div>
      {open ? (
        <>
          <ol className="pl-steps">
            <li>Логин — ваш адрес в Яндексе, например <code>ivan@yandex.ru</code>.</li>
            <li>Создайте <b>пароль приложения</b>: <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noopener noreferrer">id.yandex.ru → Безопасность → Пароли приложений</a> → «Календарь (CalDAV)». Обычный пароль аккаунта не подойдёт.
              <details className="pl-details"><summary>Показать, где это</summary><img className="pl-guide-image" src={yandexStep3} alt="Страница «Создать пароль приложения» в Яндекс ID: пункт «Календарь, CalDAV»" loading="lazy" /></details>
            </li>
            <li>Необязательно: CalDAV-ссылка одного календаря. Без неё подключим все календари аккаунта, и вы выберете нужные.
              <details className="pl-details"><summary>Где взять ссылку</summary>
                <p className="pl-caption" style={{ marginTop: 8 }}>Откройте <a href="https://calendar.yandex.ru/week" target="_blank" rel="noopener noreferrer">calendar.yandex.ru</a> (на телефоне — версию для компьютера), нажмите на значок настроек рядом с календарём:</p>
                <img className="pl-guide-image" src={yandexStep1} alt="Яндекс Календарь: значок настроек рядом с календарём «Мои события»" loading="lazy" />
                <p className="pl-caption">Перейдите на вкладку «Экспорт» и скопируйте ссылку из блока CalDAV:</p>
                <img className="pl-guide-image" src={yandexStep2} alt="Вкладка «Экспорт» в настройках календаря: поле CalDAV" loading="lazy" />
              </details>
            </li>
          </ol>
          <form className="pl-stack" style={{ marginTop: 12 }} onSubmit={connect}>
            <div className="pl-grid-3">
              <label className="pl-field">Логин Яндекса<input required value={login} onChange={(event) => setLogin(event.target.value)} placeholder="ivan@yandex.ru" autoComplete="username" /></label>
              <label className="pl-field">Пароль приложения<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" /></label>
              <label className="pl-field">CalDAV-ссылка (необязательно)<input value={calendarUrl} onChange={(event) => setCalendarUrl(event.target.value)} placeholder="https://caldav.yandex.ru/calendars/…" /></label>
            </div>
            <div className="pl-form-actions">{accounts.length ? <button type="button" className="pl-button secondary" onClick={() => setOpen(false)}>Отмена</button> : null}<button type="submit" className="pl-button" disabled={busy}>{busy ? 'Проверяю…' : 'Подключить'}</button></div>
          </form>
          {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
        </>
      ) : null}
      {accounts.map((account) => <AccountCard key={account.id} account={account} onChange={onChange} />)}
    </article>
  )
}

function TelegramCard() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [token, setToken] = useState('')
  const [link, setLink] = useState<TelegramLink | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const poll = useRef<number | null>(null)
  const load = () => planningApi.telegram().then(setStatus).catch((cause) => setError(errorText(cause)))
  useEffect(() => { void load(); return () => { if (poll.current) window.clearInterval(poll.current) } }, [])

  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError(''); setMessage('')
    try { await work() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  function waitForChat(count: number, expires: number) {
    if (poll.current) window.clearInterval(poll.current)
    poll.current = window.setInterval(async () => {
      const next = await planningApi.telegram().catch(() => null)
      if (next) setStatus(next)
      if ((next && next.chats.length > count) || Date.now() > expires) {
        if (poll.current) window.clearInterval(poll.current)
        poll.current = null
        if (next && next.chats.length > count) { setLink(null); setMessage('Чат привязан ✓ Утренний план и напоминания будут приходить туда.') }
      }
    }, 3000)
  }

  return (
    <article className="pl-card">
      <div className="pl-spread">
        <div className="pl-provider"><span className="pl-provider-logo telegram">✈</span><div><h3>Telegram</h3><p className="pl-caption">Утренний план, напоминания и добавление дел сообщением</p></div></div>
        {status?.configured ? <div className="pl-row">{status.managed ? <span className="pl-badge accent">бот проекта</span> : null}{status.running ? <span className="pl-badge green">работает</span> : <span className="pl-badge red">остановлен</span>}{status.botUsername ? <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer">@{status.botUsername}</a> : null}</div> : null}
      </div>
      {status && !status.configured ? (
        <>
          <p className="pl-muted" style={{ marginTop: 12 }}>Обычно бот общий для всего проекта: его токен задаётся на сервере в <code className="pl-code">backend/.env</code> (<code className="pl-code">TELEGRAM_BOT_TOKEN</code>), и бот запускается вместе с сервисом. Если его там нет, можно подключить своего бота:</p>
          <ol className="pl-steps">
            <li>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>, отправьте <code>/newbot</code>, задайте имя и адрес бота — он должен оканчиваться на <code>bot</code>.</li>
            <li>Скопируйте токен вида <code>123456789:AA…</code> и вставьте ниже.</li>
            <li>Нажмите «Привязать чат» — откроется ваш бот, нажмите «Start». Привязка по одноразовой ссылке, чужие чаты данные не получат.</li>
          </ol>
          <p className="pl-caption" style={{ marginTop: 8 }}>Бот работает через long polling, публичный адрес не нужен. Сообщения приходят, пока запущен backend. Не используйте токен бота, который уже запущен в другой программе.</p>
          <form className="pl-row" style={{ marginTop: 12 }} onSubmit={(event) => { event.preventDefault(); void run(async () => { setStatus(await planningApi.configureTelegram(token)); setToken('') }) }}>
            <label className="pl-field" style={{ flex: 1, minWidth: 240 }}>Токен бота<input required type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="123456789:AA…" /></label>
            <button type="submit" className="pl-button" style={{ alignSelf: 'flex-end' }} disabled={busy}>{busy ? 'Проверяю…' : 'Подключить бота'}</button>
          </form>
        </>
      ) : null}
      {status?.configured ? (
        <div className="pl-stack" style={{ marginTop: 14 }}>
          {status.managed ? <p className="pl-muted">Бот {status.botUsername ? `@${status.botUsername} ` : ''}общий для проекта и запускается вместе с сервером — создавать своего не нужно. Нажмите «Привязать чат»: откроется бот, нажмите «Start».</p> : null}
          {status.error ? <p className="pl-notice error">{status.error}</p> : null}
          <div className="pl-row">
            <button type="button" className="pl-button" disabled={busy || !status.running} onClick={() => run(async () => {
              const value = await planningApi.telegramLink()
              setLink(value)
              if (value.url) window.open(value.url, '_blank', 'noopener')
              waitForChat(status.chats.length, Date.parse(value.expiresAt))
            })}>Привязать чат</button>
            <button type="button" className="pl-button secondary" disabled={busy || !status.chats.length} onClick={() => run(async () => { const result = await planningApi.telegramTest(); setMessage(`Отправлено в чатов: ${result.sent}`) })}>Отправить проверку</button>
            {status.managed ? null : <button type="button" className="pl-button danger small" disabled={busy} onClick={() => window.confirm('Отключить бота и отвязать все чаты?') && run(async () => setStatus(await planningApi.removeTelegram()))}>Отключить бота</button>}
          </div>
          {link ? <p className="pl-notice">Откройте <a href={link.url ?? '#'} target="_blank" rel="noopener noreferrer">{link.url}</a> и нажмите «Start». Или отправьте боту: <code className="pl-code">/start {link.code}</code>. Ссылка действует до {new Date(link.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.</p> : null}
          {status.chats.length ? (
            <ul className="pl-calendar-list">{status.chats.map((chat) => <li key={chat.chatId}><span>{chat.title}<span className="pl-caption"> · привязан {when(chat.linkedAt)}</span></span><button type="button" className="pl-button secondary small" onClick={() => run(async () => setStatus(await planningApi.unlinkChat(chat.chatId)))}>Отвязать</button></li>)}</ul>
          ) : <p className="pl-caption">Чатов пока нет. Нажмите «Привязать чат».</p>}
          <p className="pl-caption">В боте: /today, /tomorrow, /week, /tasks, /sync или просто текст — «завтра в 15 созвон».</p>
        </div>
      ) : null}
      {message ? <p className="pl-notice success" role="status">{message}</p> : null}
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
    </article>
  )
}

export default function ConnectionsView() {
  const { revision, refresh, settings, calendars } = usePlanning()
  const [accounts, setAccounts] = useState<CalendarAccount[]>([])
  const [log, setLog] = useState<SyncReport[]>([])
  const [localCount, setLocalCount] = useState(0)
  const [moved, setMoved] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([planningApi.accounts(controller.signal), planningApi.syncLog(controller.signal), planningApi.localEventsCount(controller.signal)]).then(([items, reports, local]) => { setAccounts(items); setLog(reports); setLocalCount(local.count) }).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [revision])
  const writable = calendars.filter((calendar) => calendar.writable && calendar.enabled)
  const target = writable.find((calendar) => calendar.id === settings.defaultCalendarId)
  async function moveLocal() {
    if (!target) return
    try { const result = await planningApi.moveLocalEvents(target.id); setMoved(`Отправляю ${result.moved} соб. в «${target.name}» — они появятся там через несколько секунд.`); refresh() } catch (cause) { setError(errorText(cause)) }
  }

  return (
    <section className="pl-section" aria-labelledby="pl-connections-title">
      <h2 className="pl-section-title" id="pl-connections-title">Подключения</h2>
      <p className="pl-muted" style={{ marginTop: 6, maxWidth: '70ch' }}>Данные доступа вводятся здесь и хранятся только на вашем backend в зашифрованном виде. Синхронизация — обычный код без модели: изменения сравниваются по ETag, при правке в обоих местах остаётся более поздняя версия, а конфликт попадает в журнал.</p>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      <div className="pl-card" style={{ marginTop: 16 }}>
        <div className="pl-spread">
          <div><h3>Куда сохранять новые события</h3><p className="pl-caption">События с сайта и из Telegram попадут в этот календарь и синхронизируются</p></div>
          <label className="pl-field" style={{ minWidth: 260 }}><span className="pl-visually-hidden">Календарь по умолчанию</span>
            <select value={settings.defaultCalendarId ?? ''} onChange={(event) => planningApi.saveSettings({ defaultCalendarId: event.target.value || null }).then(refresh).catch((cause) => setError(errorText(cause)))}>
              <option value="">Только в этом приложении</option>
              {writable.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.provider === 'google' ? 'Google' : 'Яндекс'} · {calendar.name}</option>)}
            </select>
          </label>
        </div>
        {!target && writable.length ? <p className="pl-notice warning">Календарь не выбран — новые события останутся только здесь и не попадут в Google или Яндекс.</p> : null}
        {target && localCount ? (
          <div className="pl-spread" style={{ marginTop: 12 }}>
            <p className="pl-muted">Событий только в этом приложении: {localCount}. Они созданы до выбора календаря и не синхронизируются.</p>
            <button type="button" className="pl-button secondary small" onClick={moveLocal}>Отправить в «{target.name}»</button>
          </div>
        ) : null}
        {moved ? <p className="pl-notice success" role="status">{moved}</p> : null}
      </div>
      <div className="pl-connections">
        <GoogleCard accounts={accounts.filter((account) => account.provider === 'google')} onChange={refresh} />
        <YandexCard accounts={accounts.filter((account) => account.provider === 'yandex')} onChange={refresh} />
        <TelegramCard />
      </div>
      {log.length ? (
        <details className="pl-card" style={{ marginTop: 16 }}>
          <summary className="pl-muted" style={{ cursor: 'pointer' }}>Журнал синхронизации ({log.length})</summary>
          <ul className="pl-log">{log.map((report, index) => (
            <li key={`${report.at}${index}`}>
              <strong>{report.calendarName}</strong> · {when(report.at)} · получено +{report.pulled.created} ~{report.pulled.updated} −{report.pulled.deleted} · отправлено +{report.pushed.created} ~{report.pushed.updated} −{report.pushed.deleted}
              {report.conflicts.map((conflict) => <div key={conflict.eventId + conflict.reason}>⚠ «{conflict.title}»: {conflict.reason}</div>)}
              {report.errors.map((item) => <div key={item} style={{ color: 'var(--red)' }}>{item}</div>)}
            </li>
          ))}</ul>
        </details>
      ) : null}
    </section>
  )
}
