import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatSource, TrendChatMessage, TrendChatProgress, TrendChatRequest, TrendConversation, TrendConversationSummary, TrendChatToolInfo } from '../../../../shared/trend-chat'
import type { TrendCapabilities, TrendMode, TrendReport } from '../../../../shared/trends'
import { createConversation, getChatTools, listConversations, loadConversation, sendChatMessage } from './chat-api'
import { loadHistory, saveModuleContext } from './api'
import { collectModuleContexts } from './moduleContext'
import './TrendChat.css'

const labels: Record<string, string> = { update_brief: 'Параметры исследования', research_now: 'Новое исследование', list_reports: 'История отчётов', filter_sources: 'Фильтрация источников', inspect_source: 'Просмотр источника', compare_reports: 'Сравнение отчётов', save_source: 'Закладка', list_saved_sources: 'Сохранённые источники', finish_chat: 'Ответ по основаниям' }
const purposes: Record<string, string> = { update_brief: 'Меняет тему, область и период без поиска.', research_now: 'Запускает один поиск по вашей просьбе.', list_reports: 'Находит прошлые отчёты.', filter_sources: 'Отбирает уже собранные материалы.', inspect_source: 'Показывает сохранённый текст и его ограничения.', compare_reports: 'Сравнивает полученные выборки ссылок.', save_source: 'Сохраняет выбранный источник по вашей просьбе.', list_saved_sources: 'Показывает закладки этого профиля.', finish_chat: 'Связывает ответ с настоящими источниками.' }
const storageKey = 'graphite-trend-conversation-v1'
const rememberId = (id: string | null) => { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey) } catch { /* SQLite remains the source of truth. */ } }
const storedId = () => { try { return localStorage.getItem(storageKey) } catch { return null } }
function Sources({ sources }: { sources: ChatSource[] }) {
  return <ol className="tc-sources">{sources.map((source, index) => <li key={`${source.reportId}-${source.id}`}><span className="tc-source-number mono">{index + 1}</span><div><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a><p className="form-caption">{source.mode === 'demo' ? 'Демо · ' : ''}{source.publisher} · {source.read ? 'сохранённый текст прочитан' : source.kind === 'rss' ? 'RSS-фрагмент' : 'метаданные'} · {source.publishedAt ? new Date(source.publishedAt).toLocaleDateString('ru-RU') : 'дата неизвестна'}</p></div></li>)}</ol>
}
function Message({ message, onReport }: { message: TrendChatMessage; onReport: (id: string) => void }) {
  return <article className={`tc-message tc-${message.role}`}>
    <div className="tc-message-meta"><span>{message.role === 'user' ? 'Вы' : 'Исследователь'}</span><span className="mono">{message.dataMode === 'demo' ? 'Демо · ' : ''}{message.role === 'assistant' ? message.mode === 'tools' ? 'Обычные инструменты' : message.mode === 'fallback' ? 'Ограниченный ответ' : 'Агент' : ''}</span></div>
    <p className="tc-message-text">{message.text}</p>
    {message.citations.length ? <Sources sources={message.citations} /> : null}
    {message.comparison ? <div className="tc-comparison"><p>{message.comparison.comparable ? `Новые ссылки: ${message.comparison.added.length} · Повторные: ${message.comparison.repeated.length} · Не встретились: ${message.comparison.missing.length}` : 'Эти отчёты напрямую не сопоставляются'}</p>{message.comparison.notes.map((note) => <p className="form-caption" key={note}>{note}</p>)}</div> : null}
    {message.reportIds.length ? <div className="tc-report-links">{message.reportIds.slice(0, 8).map((id, index) => <button type="button" key={id} onClick={() => onReport(id)}>Открыть отчёт{message.reportIds.length > 1 ? ` ${index + 1}` : ''} ↗</button>)}</div> : null}
    {message.steps?.length ? <details className="tc-tools-trace"><summary>Действия · {message.steps.length}</summary><ol>{message.steps.map((step, index) => <li key={`${step.tool}-${index}`}><span>{labels[step.tool] || step.tool}</span><span className={step.status === 'error' ? 'trace-error' : 'mono'}>{step.summary}</span></li>)}</ol></details> : null}
  </article>
}
export default function TrendChat({ capabilities, openConversationId, onReport, onResearchComplete }: { capabilities: TrendCapabilities | null; openConversationId?: string; onReport: (report: TrendReport) => void; onResearchComplete: () => void }) {
  const [conversation, setConversation] = useState<TrendConversation | null>(null)
  const [sessions, setSessions] = useState<TrendConversationSummary[]>([])
  const [tools, setTools] = useState<TrendChatToolInfo[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<TrendMode>('live')
  const [enableAi, setEnableAi] = useState(true), [useWeb, setUseWeb] = useState(true), [useModules, setUseModules] = useState(true)
  const [loadedFor, setLoadedFor] = useState<string | undefined | null>(null)
  const [pendingRead, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [pendingText, setPendingText] = useState(''), [progress, setProgress] = useState<TrendChatProgress | null>(null)
  const [retry, setRetry] = useState<{ id: string; request: TrendChatRequest } | null>(null)
  const loading = pendingRead || loadedFor !== openConversationId
  const controller = useRef<AbortController | null>(null), generation = useRef(0), log = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const abort = new AbortController(), current = ++generation.current
    Promise.all([listConversations(abort.signal), getChatTools(abort.signal)]).then(async ([items, definitions]) => {
      if (generation.current !== current) return
      setSessions(items); setTools(definitions); setError('')
      const selected = openConversationId || (items.some((item) => item.id === storedId()) ? storedId() : items[0]?.id)
      if (selected) {
        const value = await loadConversation(selected, abort.signal)
        if (generation.current === current) { setConversation(value); setMode(value.mode); rememberId(value.id) }
      } else setConversation(null)
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось открыть чат') }).finally(() => { if (generation.current === current) { setLoading(false); setLoadedFor(openConversationId) } })
    return () => { abort.abort(); controller.current?.abort() }
  }, [openConversationId])
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [conversation?.messages.length, pendingText, progress?.message])
  async function select(id: string) {
    const current = ++generation.current
    setError(''); setRetry(null); setDraft('')
    if (!id) { setConversation(null); rememberId(null); return }
    setLoading(true)
    try { const value = await loadConversation(id, AbortSignal.timeout(10000)); if (generation.current === current) { setConversation(value); setMode(value.mode); rememberId(value.id) } }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть диалог') }
    finally { if (generation.current === current) setLoading(false) }
  }
  async function send(event?: FormEvent, replay = false) {
    event?.preventDefault()
    if (busy || loading || (!draft.trim() && !replay)) return
    const abort = new AbortController(); controller.current = abort
    const timeout = window.setTimeout(() => abort.abort(), 330000)
    setBusy(true); setError(''); setProgress({ message: 'Готовим контекст диалога' })
    try {
      let active = conversation
      if (!active) { active = await createConversation(undefined, abort.signal); setConversation(active); rememberId(active.id); setSessions((items) => [{ id: active!.id, title: active!.title, revision: active!.revision, updatedAt: active!.updatedAt }, ...items.filter((item) => item.id !== active!.id)]) }
      const request: TrendChatRequest = replay && retry ? retry.request : { turnId: crypto.randomUUID(), expectedRevision: active.revision, text: draft.trim(), mode, enableAi: enableAi && Boolean(capabilities?.agent?.configured), useWeb, useModuleContext: useModules }
      const id = replay && retry ? retry.id : active.id
      setRetry({ id, request }); setPendingText(request.text); setDraft('')
      if (request.useModuleContext) { const contexts = await collectModuleContexts(); await Promise.all(contexts.map((context) => saveModuleContext(context, abort.signal))) }
      const result = await sendChatMessage(id, request, abort.signal, setProgress)
      if (result.conversation.messages.find((message) => message.id === result.messageId)?.steps?.some((step) => step.tool === 'research_now' && step.status === 'ok')) onResearchComplete()
      setConversation(result.conversation); rememberId(result.conversation.id); setRetry(null)
      try { setSessions(await listConversations(abort.signal)) } catch { /* The completed message remains successful if only the list refresh fails. */ }
    } catch (cause) { setError(abort.signal.aborted ? 'Сообщение остановлено. Диалог можно обновить перед повторной отправкой.' : cause instanceof Error ? cause.message : 'Не удалось отправить сообщение') }
    finally { window.clearTimeout(timeout); setBusy(false); setPendingText(''); setProgress(null) }
  }
  async function refresh() {
    if (!conversation || busy) return
    setLoading(true); setError('')
    try {
      const value = await loadConversation(conversation.id, AbortSignal.timeout(10000))
      setConversation(value)
      const committed = retry && value.messages.some((message) => message.turnId === retry.request.turnId)
      if (retry && !committed) { setDraft(retry.request.text); setRetry({ ...retry, request: { ...retry.request, expectedRevision: value.revision } }) }
      else { setRetry(null); setDraft('') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить диалог') }
    finally { setLoading(false) }
  }
  async function openReport(id: string) { setError(''); try { onReport(await loadHistory(id)) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Отчёт недоступен') } }
  const configured = Boolean(capabilities?.agent?.configured)
  return <section className="trend-chat" aria-label="Чат исследователя трендов">
    <div className="tc-toolbar"><div><p className="eyebrow">Диалог с исследователем</p><p className="tc-subtitle">От вопроса — к проверяемым источникам</p></div><div className="tc-session-controls"><select aria-label="История диалогов" disabled={busy || loading} value={conversation?.id || ''} onChange={(event) => select(event.target.value)}><option value="">Новый диалог</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => select('')}>Новый</button></div></div>
    {conversation?.brief.query ? <div className="tc-brief"><span>{conversation.brief.query}</span><span className="mono">{conversation.brief.windowDays} дн. · {{ all: 'Все области', finance: 'Финансы', health: 'Спорт и питание', wardrobe: 'Гардероб', planning: 'Дела' }[conversation.brief.domain]}</span></div> : null}
    <div className="tc-log" ref={log} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy}>
      {loading ? <p className="form-caption tc-loading">Открываем диалог…</p> : null}
      {!loading && !conversation?.messages.length ? <div className="tc-welcome"><span className="tc-mark" aria-hidden="true">↗</span><h2>Что исследуем?</h2><p>Можно найти материалы, уточнить период и обсудить, что в источниках подтверждено.</p><div className="tc-suggestions">{['Найди силовые тренировки за 14 дней', '/тема AI agents', '/история'].map((text) => <button type="button" disabled={busy} key={text} onClick={() => setDraft(text)}>{text} ↗</button>)}</div></div> : null}
      {conversation?.messages.map((message) => <Message key={message.id} message={message} onReport={openReport} />)}
      {pendingText ? <article className="tc-message tc-user tc-pending"><div className="tc-message-meta">Вы · отправляется</div><p className="tc-message-text">{pendingText}</p></article> : null}
      {busy ? <div className="tc-progress" role="status"><span className="loading-dot" /><div><p>{progress?.message || 'Работаем над ответом…'}</p>{progress?.step ? <p className="form-caption">{labels[progress.step.tool] || progress.step.tool} · {progress.step.summary}</p> : null}</div><button type="button" className="secondary-button" onClick={() => controller.current?.abort()}>Остановить</button></div> : null}
    </div>
    {error ? <div className="tc-error" role="alert"><p>{error}</p><div>{retry ? <button type="button" disabled={busy} onClick={() => send(undefined, true)}>Повторить это сообщение</button> : null}{conversation ? <button type="button" disabled={busy} onClick={refresh}>Обновить диалог</button> : null}</div></div> : null}
    <form className="tc-composer" onSubmit={send}>
      <label className="visually-hidden" htmlFor="trend-chat-message">Сообщение исследователю</label>
      <textarea id="trend-chat-message" rows={3} maxLength={4000} value={draft} disabled={busy || loading} onChange={(event) => setDraft(event.target.value)} placeholder="Напишите тему или вопрос по найденным материалам…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className="tc-composer-footer"><span className="form-caption">Enter — отправить · Shift+Enter — новая строка</span><button type="submit" className="primary-button" disabled={busy || loading || !draft.trim()} aria-label="Отправить сообщение">Отправить <span aria-hidden="true">↑</span></button></div>
    </form>
    <div className="tc-quick-actions">{['Покажи все источники', 'Только с датой', '/закладки'].map((text) => <button type="button" key={text} disabled={busy || loading} onClick={() => setDraft(text)}>{text}</button>)}</div>
    <details className="tc-settings"><summary>Режим и инструменты</summary><fieldset disabled={busy}><div className="tc-options"><label>Данные<select aria-label="Данные чата" value={mode} onChange={(event) => setMode(event.target.value as TrendMode)}><option value="live">Живые источники</option><option value="demo">Демоданные</option></select></label><label className="ai-toggle"><input type="checkbox" checked={enableAi && configured} disabled={!configured} onChange={(event) => setEnableAi(event.target.checked)} />Свободный диалог с моделью</label><label className="ai-toggle"><input type="checkbox" checked={useWeb} disabled={mode === 'demo'} onChange={(event) => setUseWeb(event.target.checked)} />Интернет для нового исследования</label><label className="ai-toggle"><input type="checkbox" checked={useModules} onChange={(event) => setUseModules(event.target.checked)} />Учитывать сводки разделов</label></div></fieldset><p className="form-caption">Диалоги сохраняются в локальной базе backend. При включённой модели профиль и выбранные сводки доступны её провайдеру. Команды и фильтры работают без модели; повторный поиск запускается по вашей просьбе.</p><ul className="tc-tool-catalog">{tools.map((tool) => <li key={tool.name}><strong>{labels[tool.name]}</strong><span>{purposes[tool.name]}</span></li>)}</ul></details>
  </section>
}
