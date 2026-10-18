import { useState } from 'react'
import type { TrendReport } from '../../../../shared/trends'
import ResearchBrief from './ResearchBrief'
import { sendFeedback } from './api'

import { toolLabels } from './labels'

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
  const citations = new Map([...report.articles, ...(report.webResults || [])].map((item) => [item.id, item]))
  return (
    <>
      {report.agent ? <section className="agent-panel">
        <div className="result-heading"><h2>Персональное исследование</h2><span className="mono">{report.agent.mode === 'model' ? 'Планировщик модели' : 'Сценарий инструментов'}</span></div>
        <ResearchBrief plan={report.agent.plan} quality={report.agent.quality} metrics={report.agent.metrics} />
        <p className="agent-summary">{report.agent.summary}</p>
        <p className="form-caption">{report.agent.stopReason}</p>
        <div className="personal-findings">{report.agent.findings.map((finding, index) => <article key={`${finding.title}-${index}`}>
          <div className="finding-heading"><h3>{finding.title}</h3>{finding.support ? <span className="support-label">{{ page: 'Страница прочитана', excerpt: 'RSS-фрагменты', metadata: 'Метаданные', mixed: 'Разные типы оснований' }[finding.support.level]}</span> : null}</div><p>{finding.summary}</p><p className="why-relevant"><span>Почему вам: </span>{finding.whyRelevant}</p>
          {finding.supportingQuotes?.map((quote, quoteIndex) => <blockquote key={`${quote.evidenceId}-${quoteIndex}`} className="support-quote"><p>«{quote.quote}»</p><cite>{citations.get(quote.evidenceId)?.title}</cite></blockquote>)}
          {finding.support?.limitations.length ? <details className="finding-limitations"><summary>Ограничения вывода ({finding.support.limitations.length})</summary><ul>{finding.support.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details> : null}
          <ul>{finding.evidenceIds.map((id) => { const source = citations.get(id); return source ? <li key={id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a></li> : null })}</ul>
        </article>)}</div>
        <details className="tool-trace"><summary>Ход исследования · {report.agent.steps.length} действий</summary><ol>{report.agent.steps.map((step, index) => <li key={`${step.tool}-${index}`}><span>{toolLabels[step.tool] || step.tool}</span><span className={step.status === 'error' ? 'trace-error' : 'mono'}>{step.summary}</span><span className="mono">{step.durationMs} мс</span></li>)}</ol></details>
      </section> : null}
      {report.webResults?.length ? <details className="web-findings">
        <summary>Материалы из интернета ({report.webResults.length})</summary>
        <div className="web-grid">{report.webResults.map((item) => <article key={item.id}>
          <p className="mono">{item.sourceName} · {item.fromMemory ? 'из памяти' : item.read ? 'текст прочитан' : item.kind === 'paper' ? 'научные метаданные' : 'поисковая выдача'}</p>
          <a className="web-title" href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a>
          <p>{item.snippet.slice(0, 400)}</p>
          <p className="form-caption">{item.publishedAt ? `Опубликовано: ${new Date(item.publishedAt).toLocaleDateString('ru-RU')}` : 'Дата публикации не установлена · в росте не учитывается'}</p>
          {item.relevance?.reasons.length ? <p className="form-caption">{item.relevance.reasons.join(' · ')}</p> : null}
          <div className="feedback-actions"><button type="button" disabled={pending !== null} aria-pressed={feedback[item.url] === 'useful'} onClick={() => vote(item.url, 'useful')}>Полезно</button><button type="button" disabled={pending !== null} aria-pressed={feedback[item.url] === 'not_useful'} onClick={() => vote(item.url, 'not_useful')}>Не по теме</button>{feedback[item.url] ? <span className="mono">Учтём в следующем поиске</span> : null}</div>
        </article>)}</div>
      </details> : null}
      {error ? <p className="notice error-notice" role="alert">{error}</p> : null}
    </>
  )
}
