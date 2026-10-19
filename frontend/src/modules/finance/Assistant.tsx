import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { FinanceChatRequest, FinanceConversation, FinanceConversationSummary, FinanceEvidence, FinanceMessage, FinanceState } from '../../../../shared/finance'
import { createConversation, FinanceChatError, listConversations, loadConversation, sendChatMessage } from './chat-api'
import DraftProvenance from './DraftProvenance'
import AnalysisReply from './AnalysisReply'
import type { FinanceAction } from './types'
import { workspaceProfile } from '../../lib/profile'

const storageKey = `graphite-finance-conversation-v1${workspaceProfile() === 'demo' ? ':demo' : ''}`
const remember = (id: string | null) => { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey) } catch { /* History is stored by the backend. */ } }
const storedId = () => { try { return localStorage.getItem(storageKey) } catch { return null } }
const methodLabels = { rules: 'Обычные инструменты', model: 'С участием модели', mixed: 'Правила и модель' }
const tools: Record<string, string> = { finance_compare_expenses: 'Сравнение периодов', finance_expense_breakdown: 'Детализация расходов', finance_unusual_expenses: 'Проверка необычных трат', finance_recurring_expenses: 'Поиск повторений', finance_spending_scenario: 'Расчёт сценария', finance_weekly_summary: 'Недельная сводка', finance_explain_analysis: 'Объяснение по фактам', list_accounts: 'Счета', list_categories: 'Категории', list_operations: 'Операции', get_balance: 'Остатки', get_stats: 'Статистика', create_draft: 'Создание черновика', update_draft: 'Уточнение черновика', finish: 'Ответ' }
type Retry = { id: string; request: FinanceChatRequest }

export default function Assistant({ data, busy, run, onDrafts, onEvidence }: { data: FinanceState; busy: boolean; run: FinanceAction; onDrafts: () => void; onEvidence: (evidence: FinanceEvidence) => void }) {
  const [text, setText] = useState('')
  const [conversation, setConversation] = useState<FinanceConversation | null>(null)
  const [sessions, setSessions] = useState<FinanceConversationSummary[]>([])
  const [loading, setLoading] = useState(true), [sending, setSending] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [progress, setProgress] = useState(''), [pendingText, setPendingText] = useState('')
  const [retry, setRetry] = useState<Retry | null>(null), [conflict, setConflict] = useState(false)
  const active = useRef(false), generation = useRef(0), locked = useRef(false), controller = useRef<AbortController | null>(null), log = useRef<HTMLDivElement>(null)
  const disabled = busy || sending || loading

  useEffect(() => {
    active.current = true
    const epoch = ++generation.current, abort = new AbortController()
    controller.current = abort; locked.current = true
    Promise.resolve().then(async () => {
      if (abort.signal.aborted) return
      setLoading(true); setSending(false); setPendingText(''); setProgress('')
      const items = await listConversations(abort.signal)
      const saved = storedId(), selected = items.some((item) => item.id === saved) ? saved : items[0]?.id
      const value = selected ? await loadConversation(selected, abort.signal) : null
      if (active.current && generation.current === epoch) {
        setSessions(items); setConversation(value); setError(''); remember(value?.id ?? null)
        setRetry((attempt) => attempt && value?.id === attempt.id && !value.messages.some((item) => item.turnId === attempt.request.turnId) ? attempt : null)
      }
    }).catch((cause) => { if (active.current && generation.current === epoch && !abort.signal.aborted) setError(message(cause)) })
      .finally(() => { if (active.current && generation.current === epoch) { setLoading(false); locked.current = false } })
    return () => { active.current = false; abort.abort(); controller.current?.abort(); locked.current = false }
  }, [])

  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [conversation?.messages.length, pendingText, progress])

  async function select(id: string) {
    if (locked.current || busy) return
    const epoch = ++generation.current, abort = new AbortController()
    controller.current = abort; locked.current = true
    setLoading(true); setError(''); setNotice(''); setText(''); setRetry(null); setConflict(false)
    const timeout = window.setTimeout(() => abort.abort(), 15000)
    try {
      const value = id ? await loadConversation(id, abort.signal) : null
      if (active.current && generation.current === epoch) { setConversation(value); remember(value?.id ?? null) }
    } catch (cause) { if (active.current && generation.current === epoch) setError(abort.signal.aborted ? 'Не удалось открыть диалог за отведённое время.' : message(cause)) }
    finally { window.clearTimeout(timeout); if (active.current && generation.current === epoch) { setLoading(false); locked.current = false } }
  }

  async function send(event?: FormEvent, replay = false) {
    event?.preventDefault()
    if (locked.current || busy || (retry && !replay) || (!text.trim() && !replay) || (replay && (!retry || conflict))) return
    const epoch = generation.current, abort = new AbortController()
    controller.current = abort; locked.current = true
    const timeout = window.setTimeout(() => abort.abort(), 75000)
    setSending(true); setError(''); setNotice(''); setProgress('Готовим контекст диалога')
    try {
      let current = conversation
      if (!current) {
        current = await createConversation(abort.signal)
        if (!active.current || generation.current !== epoch) return
        setConversation(current); remember(current.id)
        const created = current
        setSessions((items) => [created, ...items.filter((item) => item.id !== created.id)])
      }
      const attempt: Retry = replay && retry ? retry : { id: current.id, request: { turnId: crypto.randomUUID(), expectedRevision: current.revision, text: text.trim() } }
      setRetry(attempt); setPendingText(attempt.request.text); setText('')
      const result = await sendChatMessage(attempt.id, attempt.request, abort.signal, (value) => { if (active.current && generation.current === epoch) setProgress(value.message) })
      if (!active.current || generation.current !== epoch || abort.signal.aborted) return
      setConversation(result.conversation); remember(result.conversation.id); setRetry(null); setConflict(false)
      if (result.replayed) setNotice('Показан ранее сохранённый ответ. Повторная операция не создавалась.')
      try { const items = await listConversations(abort.signal); if (active.current && generation.current === epoch) setSessions(items) } catch { /* A saved answer remains successful if refreshing the picker fails. */ }
      if (active.current && generation.current === epoch) void run('Обновляем учёт', async () => undefined)
    } catch (cause) {
      if (active.current && generation.current === epoch) {
        setConflict(cause instanceof FinanceChatError && cause.conflict)
        setError(abort.signal.aborted ? 'Запрос остановлен. Обновите диалог, чтобы проверить сохранённый результат, или повторите то же сообщение.' : message(cause))
      }
    } finally {
      window.clearTimeout(timeout)
      if (active.current && generation.current === epoch) { setSending(false); setPendingText(''); setProgress(''); locked.current = false }
    }
  }

  async function refresh() {
    if (!conversation || locked.current || busy) return
    const epoch = generation.current, abort = new AbortController()
    controller.current = abort; locked.current = true
    setLoading(true); setError('')
    const timeout = window.setTimeout(() => abort.abort(), 15000)
    try {
      const value = await loadConversation(conversation.id, abort.signal)
      if (!active.current || generation.current !== epoch) return
      const committed = retry && value.messages.some((item) => item.turnId === retry.request.turnId)
      setConversation(value); setConflict(false)
      if (retry && !committed) { setText(retry.request.text); setNotice('Диалог обновлён. Предыдущее сообщение не сохранено; текст восстановлен для новой отправки.') }
      else { setText(''); setNotice('Диалог обновлён. Сохранённые сообщения показаны ниже.') }
      setRetry(null)
      void run('Обновляем учёт', async () => undefined)
    } catch (cause) { if (active.current && generation.current === epoch) setError(abort.signal.aborted ? 'Истекло время обновления диалога.' : message(cause)) }
    finally { window.clearTimeout(timeout); if (active.current && generation.current === epoch) { setLoading(false); locked.current = false } }
  }

  return <>
    <section className="finance-panel">
      <div className="finance-section-heading"><div><p className="eyebrow">Инструменты + агент</p><h2>Финансовый помощник</h2></div><div className="finance-chat-controls"><label>История диалогов<select disabled={disabled} value={conversation?.id ?? ''} onChange={(event) => { void select(event.target.value) }}><option value="">Новый диалог</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="finance-button" disabled={disabled} onClick={() => { void select('') }}>Новый</button></div></div>
      <p className="finance-caption">Диалог хранится на сервере. Помощник разбирает расходы и показывает операции в основании выводов. Новая запись в учёте требует вашего подтверждения.</p>
      {!data.capabilities.text ? <p className="finance-caption">Модель не настроена. Команды и аналитические расчёты доступны обычными инструментами; агентная детализация подключается вместе с моделью.</p> : null}
      <div className="finance-chat-suggestions">{['Покажи баланс', 'Почему в этом месяце потратил больше?', 'Есть ли необычные расходы?', 'Найди мои регулярные платежи', 'Что будет, если сократить продукты на 20%?', 'Как прошла моя финансовая неделя?'].map((value) => <button type="button" className="finance-button finance-quiet" disabled={disabled || Boolean(retry)} key={value} onClick={() => setText(value)}>{value}</button>)}</div>
    </section>
    <div className="finance-chat finance-chat-log" ref={log} role="log" aria-label="История финансового диалога" aria-live="polite" aria-relevant="additions text" aria-busy={sending || loading}>
      {loading ? <p className="finance-caption" role="status">Открываем диалог…</p> : null}
      {conversation?.messages.map((item) => <ChatMessage key={item.id} item={item} disabled={disabled} onDrafts={onDrafts} onEvidence={onEvidence} />)}
      {pendingText ? <article className="finance-panel finance-chat-pending"><span className="finance-badge">Вы · отправляется</span><p className="finance-message-text">{pendingText}</p></article> : null}
      {!loading && !conversation?.messages.length && !pendingText ? <p className="finance-empty">Опишите операцию или задайте вопрос. На уточнение можно ответить коротко: «с карты» или «вчера».</p> : null}
    </div>
    {sending ? <div className="finance-chat-progress" role="status"><p><span className="finance-loading-dot" />{progress || 'Готовим ответ…'}</p><button type="button" className="finance-button" onClick={() => controller.current?.abort()}>Остановить</button></div> : null}
    {notice ? <p className="finance-notice" role="status">{notice}</p> : null}
    {error ? <div className="finance-error" role="alert"><p>{error}</p><div className="finance-actions">{retry && !conflict ? <button className="finance-button" disabled={disabled} onClick={() => { void send(undefined, true) }}>Повторить это сообщение</button> : null}{conversation ? <button className="finance-button" disabled={disabled} onClick={() => { void refresh() }}>Обновить диалог</button> : null}</div>{conflict ? <p>Диалог изменился в другом окне. Обновите его перед новой отправкой.</p> : null}</div> : null}
    <section className="finance-panel"><form onSubmit={(event) => { void send(event) }} className="finance-agent-form"><label>Сообщение<textarea rows={3} maxLength={4000} value={text} disabled={disabled || Boolean(retry)} onChange={(event) => setText(event.target.value)} placeholder="Потратил сегодня 850 рублей на продукты с карты. Или: сколько ушло на еду в этом месяце?" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /></label><div className="finance-actions"><button className="finance-button finance-primary" disabled={disabled || Boolean(retry) || !text.trim()} type="submit">Отправить</button><small className="finance-caption">Enter — отправить · Shift+Enter — новая строка</small>{conversation ? <button type="button" className="finance-link-button" disabled={disabled} onClick={() => { void refresh() }}>Обновить историю</button> : null}</div>{retry && !sending ? <p className="finance-caption">Сначала повторите незавершённое сообщение или обновите диалог: это предотвращает случайные дубли.</p> : null}</form></section>
  </>
}

function ChatMessage({ item, disabled, onDrafts, onEvidence }: { item: FinanceMessage; disabled: boolean; onDrafts: () => void; onEvidence: (evidence: FinanceEvidence) => void }) {
  const reply = item.reply
  return <article className={`finance-panel finance-chat-${item.role}`}><div className="finance-section-heading"><span className="finance-badge">{item.role === 'user' ? 'Вы' : 'Помощник'}</span>{reply?.method ? <span className="finance-caption">{methodLabels[reply.method]}</span> : null}</div><>{reply?.analysis ? <AnalysisReply analysis={reply.analysis} disabled={disabled} onEvidence={onEvidence} /> : <p className="finance-message-text">{item.text}</p>}</>{reply?.draft ? <><button className="finance-button finance-primary" disabled={disabled} onClick={onDrafts}>Проверить черновик</button><DraftProvenance draft={reply.draft} /></> : null}{!reply?.analysis && reply?.evidence?.length ? <div className="finance-evidence"><p className="finance-caption">Основание ответа · снимок подтверждённых операций на момент расчёта</p>{reply.evidence.map((evidence, index) => <button className="finance-button" disabled={disabled} key={`${index}-${evidence.label}`} onClick={() => onEvidence(evidence)}>{evidence.label} · {evidence.count} {operationWord(evidence.count)} ↗</button>)}<p className="finance-caption">Откроется текущий учёт с теми же фильтрами. После изменений сумма и число операций могут отличаться.</p></div> : null}{reply?.steps.length ? <details><summary>Действия помощника · {reply.steps.length}</summary><ol className="finance-tool-trace">{reply.steps.map((step, index) => <li key={`${index}-${step.tool}`}>{tools[step.tool] || step.tool} · {step.status === 'ok' ? 'выполнено' : 'ошибка'}</li>)}</ol></details> : null}</article>
}

function operationWord(value: number) { return value % 10 === 1 && value % 100 !== 11 ? 'операция' : value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 12 || value % 100 > 14) ? 'операции' : 'операций' }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Не удалось выполнить запрос.' }
