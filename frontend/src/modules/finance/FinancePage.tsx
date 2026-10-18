import { Activity, useEffect, useRef, useState } from 'react'
import type { FinanceEvidence, FinanceState, FinanceStats, OperationFilter } from '../../../../shared/finance'
import { getFinanceState, getFinanceStats } from './api'
import { moscowToday } from './money'
import type { FinanceAction } from './types'
import Ledger from './Ledger'
import Drafts from './Drafts'
import Assistant from './Assistant'
import Market from './Market'
import Settings from './Settings'
import Payments from './Payments'
import './FinancePage.css'

const tabs = [{ id: 'overview', label: 'Обзор' }, { id: 'drafts', label: 'Черновики и чеки' }, { id: 'assistant', label: 'Помощник' }, { id: 'payments', label: 'Платежи' }, { id: 'market', label: 'Активы' }, { id: 'settings', label: 'Настройки' }] as const
type Tab = typeof tabs[number]['id']

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<FinanceState | null>(null)
  const [stats, setStats] = useState<FinanceStats | null>(null)
  const [ledgerFilter, setLedgerFilter] = useState<OperationFilter>({})
  const [evidence, setEvidence] = useState<FinanceEvidence | null>(null)
  const [from, setFrom] = useState(() => `${moscowToday().slice(0, 7)}-01`)
  const [to, setTo] = useState(moscowToday)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const active = useRef(false)
  const generation = useRef(0)
  const locked = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const pending = data?.drafts.filter((item) => item.status === 'pending').length ?? 0
  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to

  function openEvidence(value: FinanceEvidence) {
    const dates = [moscowToday(), ...(data?.operations.map((operation) => operation.date) ?? [])].sort()
    setStats(null)
    setFrom(value.filter.from ?? dates[0])
    setTo(value.filter.to ?? dates[dates.length - 1])
    setLedgerFilter(value.filter)
    setEvidence(value)
    setTab('overview')
  }

  useEffect(() => {
    active.current = true
    const epoch = ++generation.current
    const pendingControllers = controllers.current
    const controller = new AbortController()
    pendingControllers.add(controller)
    locked.current = true
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    // A generation check prevents an aborted Activity's callbacks from clearing a new request.
    Promise.resolve().then(async () => {
      if (controller.signal.aborted || generation.current !== epoch) return null
      setBusy('Обновляем данные')
      setError('')
      return Promise.all([getFinanceState(controller.signal), validDates ? getFinanceStats(from, to, controller.signal) : Promise.resolve(null)])
    }).then((result) => {
      if (result && !controller.signal.aborted && generation.current === epoch) { setData(result[0]); setStats(result[1]) }
    }).catch((cause: unknown) => {
      if (active.current && generation.current === epoch) setError(controller.signal.aborted ? 'Время ожидания истекло. Проверьте backend и Postgres, затем обновите данные.' : cause instanceof Error ? cause.message : 'Не удалось загрузить финансовый модуль.')
    }).finally(() => { window.clearTimeout(timeout); pendingControllers.delete(controller); if (active.current && generation.current === epoch) { setBusy(''); locked.current = false } })
    return () => { active.current = false; for (const running of pendingControllers) running.abort(); pendingControllers.clear(); window.clearTimeout(timeout) }
  }, [from, to, revision, validDates])

  const run: FinanceAction = async (label, action, success) => {
    if (locked.current || !active.current) return false
    locked.current = true
    const epoch = generation.current
    const controller = new AbortController()
    controllers.current.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), 75000)
    setBusy(label)
    setError('')
    setNotice('')
    let completed = false
    try {
      await action(controller.signal)
      completed = true
      if (success && active.current && generation.current === epoch) setNotice(success)
      const [state, nextStats] = await Promise.all([getFinanceState(controller.signal), validDates ? getFinanceStats(from, to, controller.signal) : Promise.resolve(null)])
      if (!controller.signal.aborted && active.current && generation.current === epoch) { setData(state); setStats(nextStats) }
      return true
    } catch (cause) {
      if (active.current && generation.current === epoch) {
        const message = controller.signal.aborted ? 'Время ожидания истекло. Обновите данные и проверьте результат перед повтором.' : cause instanceof Error ? cause.message : 'Не удалось выполнить действие.'
        setError(completed ? `Действие выполнено, но обновить экран не удалось. ${message}` : message)
      }
      return false
    } finally { window.clearTimeout(timeout); controllers.current.delete(controller); if (active.current && generation.current === epoch) { setBusy(''); locked.current = false } }
  }

  return <div className="finance-page">
    <header className="finance-header"><div><p className="eyebrow">Личный помощник</p><h1 className="screen-title">Финансы и инвестиции</h1><p className="body-2">Учёт денег, проверенные записи и котировки выбранных активов.</p></div><button className="finance-button" disabled={Boolean(busy)} onClick={() => setRevision((value) => value + 1)}>Обновить данные</button></header>
    <nav className="finance-tabs" aria-label="Разделы финансов">{tabs.map((item) => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}{item.id === 'drafts' && pending ? <span className="finance-tab-count">{pending}</span> : null}</button>)}</nav>
    <div className="finance-feedback" aria-live="polite">{busy ? <p className="finance-loading" role="status"><span className="finance-loading-dot" />{busy}…</p> : null}{notice ? <p className="finance-notice" role="status">{notice}</p> : null}{error ? <p className="finance-error" role="alert">{error}</p> : null}{!validDates ? <p className="finance-error" role="alert">Выберите корректный период: начальная дата должна быть не позже конечной.</p> : null}</div>
    {!data && !busy ? <section className="finance-empty"><h2>Финансовый сервис недоступен</h2><p>Запустите backend с настроенным Postgres и примените миграции. После этого обновите данные.</p></section> : null}
    <div className="finance-body" aria-busy={Boolean(busy)}>{data ? <>
      <Activity mode={tab === 'overview' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Ledger data={data} stats={validDates ? stats : null} from={from} to={to} setFrom={(value) => { setEvidence(null); setStats(null); setFrom(value) }} setTo={(value) => { setEvidence(null); setStats(null); setTo(value) }} busy={Boolean(busy)} run={run} onDrafts={() => setTab('drafts')} onSettings={() => setTab('settings')} filter={ledgerFilter} setFilter={setLedgerFilter} evidence={evidence} clearEvidence={() => setEvidence(null)} /></div></Activity>
      <Activity mode={tab === 'drafts' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Drafts data={data} busy={Boolean(busy)} run={run} /></div></Activity>
      <Activity mode={tab === 'assistant' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Assistant data={data} busy={Boolean(busy)} run={run} onDrafts={() => setTab('drafts')} onEvidence={openEvidence} /></div></Activity>
      <Activity mode={tab === 'payments' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Payments data={data} busy={Boolean(busy)} run={run} onDrafts={() => setTab('drafts')} /></div></Activity>
      <Activity mode={tab === 'market' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Market data={data} busy={Boolean(busy)} run={run} /></div></Activity>
      <Activity mode={tab === 'settings' ? 'visible' : 'hidden'}><div className="finance-tab-content"><Settings data={data} busy={Boolean(busy)} run={run} /></div></Activity>
    </> : null}</div>
  </div>
}
