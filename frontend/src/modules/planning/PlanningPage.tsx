import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CalendarAccount, PlanningCapabilities, PlanningSettings } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, PlanningContext, type EditorTarget, type PlanningContextValue } from './context'
import { localDate } from './format'
import QuickAdd from './QuickAdd'
import TodayView from './TodayView'
import WeekView from './WeekView'
import TasksView from './TasksView'
import ConnectionsView from './ConnectionsView'
import SettingsView from './SettingsView'
import EventEditor from './EventEditor'
import AssistantView, { type ChatEntry } from './AssistantView'
import './trendContext'
import './Planning.css'

const tabs = [
  { id: 'today', label: 'Сегодня' }, { id: 'week', label: 'Неделя' }, { id: 'tasks', label: 'Задачи' }, { id: 'assistant', label: 'Ассистент' },
  { id: 'connections', label: 'Подключения' }, { id: 'settings', label: 'Настройки' },
] as const
type Tab = typeof tabs[number]['id']

/** Result of the Google OAuth redirect: read once, then removed from the address bar. */
function oauthNotice() {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('planning')
  if (!status) return null
  window.history.replaceState(null, '', window.location.pathname)
  return status === 'google-connected' ? { tone: 'success', text: 'Google Календарь подключён. Выберите календари для синхронизации ниже.' } : { tone: 'error', text: `Google: ${params.get('message') || 'не удалось подключить'}` }
}

export default function PlanningPage() {
  const [notice] = useState(oauthNotice)
  const [tab, setTab] = useState<Tab>(notice ? 'connections' : 'today')
  const [settings, setSettings] = useState<PlanningSettings | null>(null)
  const [capabilities, setCapabilities] = useState<PlanningCapabilities | null>(null)
  const [accounts, setAccounts] = useState<CalendarAccount[]>([])
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [chat, setChat] = useState<ChatEntry[]>([])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([planningApi.settings(controller.signal), planningApi.accounts(controller.signal)])
      .then(([value, items]) => { setSettings(value); setAccounts(items); setError('') })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [revision])
  useEffect(() => {
    const controller = new AbortController()
    planningApi.capabilities(controller.signal).then(setCapabilities).catch(() => undefined)
    // «Today» moves at midnight in the profile time zone.
    const timer = window.setInterval(() => setClock(Date.now()), 60000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [])

  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const value = useMemo<PlanningContextValue | null>(() => settings && ({
    settings, capabilities, revision, refresh, openEditor: setEditor,
    today: localDate(new Date(clock), settings.timeZone), now: clock,
    calendars: accounts.flatMap((account) => account.calendars.map((calendar) => ({ ...calendar, provider: account.provider, accountLabel: account.label }))),
  }), [settings, capabilities, revision, refresh, clock, accounts])

  return (
    <>
      <header className="pl-header">
        <div>
          <p className="eyebrow">Рабочее пространство</p>
          <h1 className="screen-title">Дела и календарь</h1>
          <p className="body-2">События, задачи и обязательства. Синхронизация с Google и Яндексом, план на день и напоминания в Telegram.</p>
        </div>
      </header>
      {notice ? <p className={`pl-notice ${notice.tone}`} role="status">{notice.text}</p> : null}
      {error && !settings ? <p className="pl-notice error" role="alert">{error}. Запустите backend: <code className="pl-code">cd backend && npm run dev</code></p> : null}
      {value ? (
        <PlanningContext.Provider value={value}>
          <div className="pl-tabs" role="tablist" aria-label="Разделы">
            {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
          </div>
          {tab === 'today' || tab === 'week' || tab === 'tasks' ? <QuickAdd /> : null}
          <div role="tabpanel">
            {tab === 'today' ? <TodayView /> : null}
            {tab === 'week' ? <WeekView /> : null}
            {tab === 'tasks' ? <TasksView /> : null}
            {tab === 'assistant' ? <AssistantView chat={chat} setChat={setChat} /> : null}
            {tab === 'connections' ? <ConnectionsView /> : null}
            {tab === 'settings' ? <SettingsView key={revision} /> : null}
          </div>
          {editor ? <EventEditor key={JSON.stringify(editor)} target={editor} onClose={() => setEditor(null)} /> : null}
        </PlanningContext.Provider>
      ) : !error ? <p className="pl-empty">Загружаем раздел…</p> : null}
    </>
  )
}
