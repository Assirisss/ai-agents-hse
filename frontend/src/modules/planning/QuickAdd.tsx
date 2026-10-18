import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PlanningDraft } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'
import DraftPanel from './DraftPanel'

const examples = ['завтра в 15 созвон с бухгалтером', 'оплатить аренду до 25-го', 'каждый понедельник в 9:30 планёрка', 'напомни в пятницу в 10 отправить отчёт']

export default function QuickAdd() {
  const { capabilities } = usePlanning()
  const [text, setText] = useState('')
  const [useAi, setUseAi] = useState(true)
  const [busy, setBusy] = useState(false)
  const [forcing, setForcing] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState<PlanningDraft | null>(null)
  const running = useRef<AbortController | null>(null)
  const aiReady = Boolean(capabilities?.ai.configured)

  useEffect(() => () => running.current?.abort(), [])

  /** `force` asks the model even when rules understood the text. */
  async function parse(event?: FormEvent, force = false, source = text) {
    event?.preventDefault()
    if (!source.trim()) return
    if (draft) void planningApi.cancelDraft(draft.id).catch(() => undefined)
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setBusy(true); setForcing(force); setError(''); setSaved('')
    try {
      setDraft(await planningApi.createDraft(source, { useAi: (useAi || force) && aiReady, force: force && aiReady }, controller.signal))
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)) } finally { setBusy(false); setForcing(false) }
  }

  return (
    <section className="pl-quick" aria-label="Быстрое добавление">
      <form className="pl-quick-form" onSubmit={parse}>
        <label className="pl-visually-hidden" htmlFor="pl-quick-text">Что запланировать</label>
        <textarea id="pl-quick-text" rows={1} value={text} maxLength={1000} placeholder="Напишите как в мессенджере: «в пятницу в 15 созвон с бухгалтером, а до 25-го сдать отчёт»"
          onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void parse() } }} />
        <div className="pl-row" style={{ flexWrap: 'nowrap' }}>
          <button className="pl-button" type="submit" disabled={busy || !text.trim()}>{busy && !forcing ? 'Разбираю…' : 'Разобрать'}</button>
          <button className="pl-button secondary" type="button" disabled={busy || !text.trim() || !aiReady} onClick={() => parse(undefined, true)}
            title={aiReady ? 'Разобрать моделью, даже если правила справились. Даты всё равно вычисляют правила.' : 'Модель не настроена на сервере'}>{forcing ? 'Модель думает…' : '✦ Моделью'}</button>
        </div>
      </form>
      <div className="pl-quick-meta">
        <span className="pl-caption">Например: {examples.map((example, index) => <span key={example}>{index ? ' · ' : ''}<button type="button" className="pl-caption" onClick={() => setText(example)}>{example}</button></span>)}</span>
        <label className="pl-check" title={aiReady ? '' : 'Задайте PLANNING_LLM_MODEL или TREND_LLM_MODEL в backend/.env'}>
          <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(event) => setUseAi(event.target.checked)} />
          {aiReady ? `Модель для сложных фраз (${capabilities?.ai.model})` : 'Модель не настроена — только правила'}
        </label>
      </div>
      {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
      {saved ? <p className="pl-notice success" role="status">{saved}</p> : null}
      {draft ? (
        <DraftPanel key={draft.id} draft={draft} onSaved={(message) => { setSaved(message); setDraft(null); setText('') }} onCancelled={() => setDraft(null)}
          action={draft.method === 'parser' && aiReady ? <button type="button" className="pl-button secondary small" disabled={busy} onClick={() => { setText(draft.text); void parse(undefined, true, draft.text) }}>{forcing ? 'Модель думает…' : '✦ Переразобрать моделью'}</button> : null} />
      ) : null}
    </section>
  )
}
