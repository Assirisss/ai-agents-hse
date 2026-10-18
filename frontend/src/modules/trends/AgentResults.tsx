import { useState } from 'react'
import type { TrendReport } from '../../../../shared/trends'
import { sendFeedback } from './api'

const toolLabels: Record<string, string> = {
  get_user_context: 'Контекст пользователя', get_module_context: 'Данные разделов', search_memory: 'Поиск в памяти', get_feed_evidence: 'Основания из RSS',
  search_web: 'Поиск в интернете', search_papers: 'Научные публикации', read_page: 'Чтение страницы', finish_research: 'Проверка итогового ответа',
}

export default function AgentResults({ report, onFeedback }: { report: TrendReport; onFeedback: () => void }) {
  const [feedback, setFeedback] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  async function vote(url: string, verdict: 'useful' | 'not_useful') {
    setPending(url); setError('')
    try { await sendFeedback(url, verdict); setFeedback((previous) => ({ ...previous, [url]: verdict })); onFeedback() }
    catch { setError('Не удалось сохранить обратную связь') }
    finally { setPending(null) }
  }
  const citations = [...report.articles, ...(report.webResults || [])]
  return (
    <>
      {report.agent ? <section className="agent-panel">
        <div className="result-heading"><h2>Персональное исследование</h2><span className="mono">{report.agent.mode === 'model' ? 'Планировщик модели' : 'Сценарий инструментов'}</span></div>
        <p className="agent-summary">{report.agent.summary}</p>
        <p className="form-caption">{report.agent.stopReason}</p>
        <div className="personal-findings">{report.agent.findings.map((finding, index) => <article key={`${finding.title}-${index}`}>
          <h3>{finding.title}</h3><p>{finding.summary}</p><p className="why-relevant"><span>Почему вам: </span>{finding.whyRelevant}</p>
          <ul>{finding.evidenceIds.map((id) => { const source = citations.find((item) => item.id === id); return source ? <li key={id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a></li> : null })}</ul>
        </article>)}</div>
        <details className="tool-trace"><summary>Ход исследования · {report.agent.steps.length} действий</summary><ol>{report.agent.steps.map((step, index) => <li key={`${step.tool}-${index}`}><span>{toolLabels[step.tool] || step.tool}</span><span className={step.status === 'error' ? 'trace-error' : 'mono'}>{step.summary}</span><span className="mono">{step.durationMs} мс</span></li>)}</ol></details>
      </section> : null}
      {report.webResults?.length ? <section className="web-findings">
        <h2>Материалы из интернета</h2>
        <div className="web-grid">{report.webResults.map((item) => <article key={item.id}>
          <p className="mono">{item.sourceName} · {item.read ? 'текст прочитан' : 'поисковая выдача'}</p>
          <a className="web-title" href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a>
          <p>{item.snippet.slice(0, 400)}</p>
          <p className="form-caption">{item.publishedAt ? `Опубликовано: ${new Date(item.publishedAt).toLocaleDateString('ru-RU')}` : 'Дата публикации не установлена · в росте не учитывается'}</p>
          {item.relevance?.reasons.length ? <p className="form-caption">{item.relevance.reasons.join(' · ')}</p> : null}
          <div className="feedback-actions"><button type="button" disabled={pending !== null} aria-pressed={feedback[item.url] === 'useful'} onClick={() => vote(item.url, 'useful')}>Полезно</button><button type="button" disabled={pending !== null} aria-pressed={feedback[item.url] === 'not_useful'} onClick={() => vote(item.url, 'not_useful')}>Не по теме</button>{feedback[item.url] ? <span className="mono">Учтём в следующем поиске</span> : null}</div>
        </article>)}</div>
      </section> : null}
      {error ? <p className="notice error-notice" role="alert">{error}</p> : null}
    </>
  )
}
