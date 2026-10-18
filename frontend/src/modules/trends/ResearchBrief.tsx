import { toolLabels } from './labels'
import type { EvidenceQuality, ResearchMetrics, ResearchPlan, ResearchProgress, ToolTrace } from '../../../../shared/trends'

export default function ResearchBrief({ plan, quality, progress, metrics, steps = [], onCancel }: { plan?: ResearchPlan; quality?: EvidenceQuality; progress?: ResearchProgress; metrics?: ResearchMetrics; steps?: ToolTrace[]; onCancel?: () => void }) {
  if (!plan && !progress && !quality) return null
  return <section className="research-brief" aria-label={onCancel ? 'Ход исследования' : 'План и качество исследования'}>
    <div className="brief-heading"><p className="eyebrow">{onCancel ? 'Исследование выполняется' : 'Проверка оснований'}</p>{onCancel ? <button type="button" className="secondary-button" onClick={onCancel}>Остановить</button> : <span className={`quality-label ${quality?.sufficient ? 'quality-ready' : ''}`}>{quality?.sufficient ? 'Базовые критерии обзора выполнены' : 'Основания ограничены'}</span>}</div>
    {plan ? <><h3>{plan.question}</h3><p className="form-caption">Ищем материалы с {new Date(plan.windowStart).toLocaleDateString('ru-RU')} по {new Date(plan.windowEnd).toLocaleDateString('ru-RU')}. Цель: {plan.criteria.minSources} материала, {plan.criteria.minPublishers} независимых издателя, {plan.criteria.minReadPages} прочитанный первоисточник.</p>
      <ol className="research-stages">{plan.stages.map((stage, index) => <li key={stage}><span className="mono">0{index + 1}</span><span>{stage}</span></li>)}</ol>
    </> : null}
    {onCancel ? <p className="research-current" role="status"><span className="loading-dot" />{progress?.message || 'Готовим исследование…'}<span className="mono">{steps.length} действий</span></p> : null}
    {onCancel && steps.length ? <ol className="research-live-log">{steps.slice(-4).map((step, index) => <li key={`${step.tool}-${steps.length - 4 + index}`}><span>{toolLabels[step.tool] || step.tool}</span><span className={step.status === 'error' ? 'trace-error' : 'mono'}>{step.status === 'error' ? step.summary : 'Готово'}</span></li>)}</ol> : null}
    {quality ? <><div className="quality-metrics"><span>Материалы: <strong>{quality.sources}</strong></span><span>Издатели: <strong>{quality.publishers}</strong></span><span>Прочитано сейчас: <strong>{quality.readPages}</strong></span><span>В периоде: <strong>{quality.recentSources}</strong></span></div>
      {quality.gaps.length ? <ul className="quality-gaps">{quality.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : null}
      <p className="form-caption">Это проверка объёма и доступности оснований. Она не доказывает истинность выводов или глобальную популярность темы.</p>
    </> : null}
    {metrics ? <details className="research-usage"><summary>Время и использование модели</summary><p className="mono">{(metrics.durationMs / 1000).toFixed(1)} с · {metrics.modelCalls} вызовов модели · {metrics.toolCalls} действий · {metrics.cachedCalls} из кэша</p><p className="mono">{metrics.promptTokens + metrics.completionTokens} токенов · {metrics.costUsd === null ? 'стоимость не сообщена провайдером' : `$${metrics.costUsd.toFixed(6)}`}</p>{metrics.models.length ? <p className="mono">{metrics.models.join(', ')}</p> : null}</details> : null}
  </section>
}
