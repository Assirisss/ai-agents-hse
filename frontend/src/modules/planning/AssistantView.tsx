import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AssistantReply, AssistantTurn } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import DraftPanel from './DraftPanel'

export type ChatEntry = { id: string; role: 'user' | 'assistant'; text: string; reply?: AssistantReply; draft?: 'open' | 'saved' | 'cancelled'; saved?: string }

const routeLabel: Record<AssistantReply['route'], string> = {
  day_plan: 'план дня', week: 'план недели', free_slots: 'свободное время', tasks: 'задачи', draft: 'черновик по правилам', agent: 'агент', help: 'подсказка',
}
const examples = ['Что у меня завтра?', 'Когда я свободен на 2 часа на этой неделе?', 'Какие задачи просрочены?', 'Распланируй подготовку к экзамену: 6 часов до пятницы блоками по 2 часа', 'Предложи, когда поставить встречу с научруком на час в среду или четверг']

/** Conversation lives in the page, so it survives switching tabs. */
export default function AssistantView({ chat, setChat }: { chat: ChatEntry[]; setChat: (update: (entries: ChatEntry[]) => ChatEntry[]) => void }) {
  const { capabilities } = usePlanning()
  const [text, setText] = useState('')
  const [agentOnly, setAgentOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const modelReady = Boolean(capabilities?.ai.configured)

  useEffect(() => () => running.current?.abort(), [])
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [chat.length, busy])

  async function send(event?: FormEvent, value = text) {
    event?.preventDefault()
    const message = value.trim()
    if (!message || busy) return
    const history: AssistantTurn[] = chat.slice(-6).map((entry) => ({ role: entry.role, content: entry.text.slice(0, 2000) }))
    setChat((entries) => [...entries, { id: crypto.randomUUID(), role: 'user', text: message }])
    setText(''); setError(''); setBusy(true)
    const controller = new AbortController()
    running.current = controller
    try {
      const reply = await planningApi.ask(message, history, agentOnly && modelReady ? 'agent' : 'auto', controller.signal)
      setChat((entries) => [...entries, { id: reply.id, role: 'assistant', text: reply.answer, reply, draft: reply.draft ? 'open' : undefined }])
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)) } finally { setBusy(false) }
  }
  const markDraft = (id: string, state: 'saved' | 'cancelled', saved?: string) => setChat((entries) => entries.map((entry) => entry.id === id ? { ...entry, draft: state, saved } : entry))

  return (
    <section className="pl-section" aria-labelledby="pl-assistant-title">
      <div className="pl-spread">
        <div>
          <h2 className="pl-section-title" id="pl-assistant-title">Ассистент</h2>
          <p className="pl-caption" style={{ marginTop: 4 }}>Простые вопросы отвечает код без модели; сложные — агент{modelReady ? ` (${capabilities?.ai.model})` : ''} с инструментами календаря. Предложения агента — черновики: сохраняете вы.</p>
        </div>
        {chat.length ? <button type="button" className="pl-button secondary small" onClick={() => setChat(() => [])} disabled={busy}>Очистить разговор</button> : null}
      </div>
      <div className="pl-chat">
        {!chat.length ? (
          <div className="pl-card">
            <h3>Что можно спросить</h3>
            <div className="pl-chips">{examples.map((example) => <button type="button" key={example} className="pl-chip-button" onClick={() => send(undefined, example)}>{example}</button>)}</div>
            {!modelReady ? <p className="pl-caption" style={{ marginTop: 12 }}>Модель не настроена: работают план, свободное время, задачи и добавление дел. Для агента задайте PLANNING_LLM_MODEL в backend/.env.</p> : null}
          </div>
        ) : null}
        {chat.map((entry) => entry.role === 'user' ? <div className="pl-bubble user" key={entry.id}>{entry.text}</div> : (
          <div className="pl-bubble assistant" key={entry.id}>
            {entry.reply ? <div className="pl-row" style={{ marginBottom: 8 }}>
              <span className={`pl-badge ${entry.reply.route === 'agent' ? 'accent' : 'green'}`}>{entry.reply.route === 'agent' ? `агент · ${entry.reply.steps.length} шаг.` : `без модели · ${routeLabel[entry.reply.route]}`}</span>
              {entry.reply.model ? <span className="pl-caption">{entry.reply.model}</span> : null}
            </div> : null}
            <p className="pl-answer">{entry.text}</p>
            {entry.reply && (entry.reply.steps.length || entry.reply.notes.length) ? (
              <details className="pl-details"><summary>Ход работы</summary>
                <ol className="pl-steps">
                  {entry.reply.notes.map((note) => <li key={note}>{note}</li>)}
                  {entry.reply.steps.map((step, index) => <li key={index}><code>{step.tool}</code> — {step.summary}{step.status === 'error' ? ' ⚠' : ''} <span className="pl-caption">{step.durationMs} мс</span></li>)}
                </ol>
              </details>
            ) : null}
            {entry.reply?.draft && entry.draft === 'open' ? <DraftPanel draft={entry.reply.draft} onSaved={(message) => markDraft(entry.id, 'saved', message)} onCancelled={() => markDraft(entry.id, 'cancelled')} /> : null}
            {entry.draft === 'saved' ? <p className="pl-notice success">{entry.saved}</p> : null}
            {entry.draft === 'cancelled' ? <p className="pl-caption" style={{ marginTop: 8 }}>Черновик отменён.</p> : null}
          </div>
        ))}
        {busy ? <div className="pl-bubble assistant"><span className="pl-typing" aria-hidden="true" /> <span className="pl-caption">Думаю… агенту может понадобиться до минуты</span></div> : null}
        <div ref={end} />
      </div>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      <form className="pl-quick pl-quick-form" onSubmit={send} style={{ marginTop: 12 }}>
        <label className="pl-visually-hidden" htmlFor="pl-assistant-input">Сообщение ассистенту</label>
        <textarea id="pl-assistant-input" rows={1} value={text} maxLength={1000} placeholder="Спросите о расписании или попросите распланировать дела"
          onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
        <div className="pl-stack" style={{ gap: 6 }}>
          <button type="submit" className="pl-button" disabled={busy || !text.trim()}>Отправить</button>
          <label className="pl-check" title={modelReady ? 'Не использовать готовые сценарии, сразу агент' : 'Модель не настроена'}><input type="checkbox" checked={agentOnly && modelReady} disabled={!modelReady} onChange={(event) => setAgentOnly(event.target.checked)} />сразу агент</label>
        </div>
      </form>
    </section>
  )
}
