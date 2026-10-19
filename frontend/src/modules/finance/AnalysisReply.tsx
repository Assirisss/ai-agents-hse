import type { FinanceAnalysis, FinanceEvidence } from '../../../../shared/finance'

export default function AnalysisReply({ analysis, disabled, onEvidence }: { analysis: FinanceAnalysis; disabled: boolean; onEvidence: (evidence: FinanceEvidence) => void }) {
  const facts = analysis.facts.filter(item => item.type === 'fact'), hypotheses = analysis.facts.filter(item => item.type === 'hypothesis')
  function statements(items: typeof facts) {
    return items.map(item => <div className="finance-analysis-statement" key={item.id}><p className="finance-message-text">{item.text}</p>{item.evidence.length ? <div className="finance-actions">{item.evidence.map((link, index) => <button className="finance-button finance-quiet" type="button" key={`${item.id}-${index}`} disabled={disabled} onClick={() => onEvidence(link)}>{link.label} · операций: {link.count} ↗</button>)}</div> : null}</div>)
  }
  return <div className="finance-analysis">
    <h3>{analysis.title}</h3>
    <p className="finance-caption">Период: {analysis.period.from} — {analysis.period.to}{analysis.previousPeriod ? ` · Сравнение: ${analysis.previousPeriod.from} — ${analysis.previousPeriod.to}` : ''}</p>
    <h4>Факты по учёту</h4>{statements(facts)}
    {hypotheses.length ? <><h4>Предположения для проверки</h4>{statements(hypotheses)}</> : null}
    <h4>Ограничения данных</h4><ul className="finance-caption">{analysis.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
    {analysis.question ? <p className="finance-notice">{analysis.question}</p> : null}
  </div>
}
