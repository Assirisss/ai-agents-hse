import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { TrendCapabilities, TrendDomain, TrendMode, TrendReport, ResearchProgress, ResearchPlan, ToolTrace } from '../../../../shared/trends'
import { getCapabilities, streamResearch, saveModuleContext } from './api'
import './TrendsPage.css'
import ResearchMemory from './ResearchMemory'
import AgentResults from './AgentResults'
import TrendChat from './TrendChat'
import { createConversation } from './chat-api'
import ResearchBrief from './ResearchBrief'
import { collectModuleContexts } from './moduleContext'

const domains: { id: TrendDomain; label: string }[] = [
  { id: 'all', label: 'Все области' }, { id: 'finance', label: 'Финансы' },
  { id: 'health', label: 'Спорт и питание' }, { id: 'wardrobe', label: 'Гардероб' },
  { id: 'planning', label: 'Дела и календарь' },
]
const signalLabels = { rising: 'Рост в выборке', new: 'Нет предыдущих упоминаний', watch: 'Наблюдение' }
const dateLabel = (date: string) => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

function RecentArticles({ report }: { report: TrendReport }) {
  const start = Date.parse(report.referenceTime) - report.request.windowDays * 86400000
  const articles = report.articles.filter((article) => Date.parse(article.publishedAt) >= start).slice(0, 8)
  if (!articles.length) return null
  return (
    <section className="recent-articles" aria-labelledby="recent-title">
      <h2 id="recent-title">Свежие публикации</h2>
      <ul>{articles.map((article) => (
        <li key={article.id}>
          <span className="mono">{article.sourceName} · {dateLabel(article.publishedAt)}</span>
          <a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<span aria-hidden="true"> ↗</span></a>
          <p>{article.snippet.slice(0, 200)}{article.snippet.length > 200 ? '…' : ''}</p>
        </li>
      ))}</ul>
    </section>
  )
}

export default function TrendsPage() {
  const [view, setView] = useState<'chat' | 'research'>('chat')
  const [chatId, setChatId] = useState<string | undefined>()
  const [openingChat, setOpeningChat] = useState(false)
  const [domain, setDomain] = useState<TrendDomain>('all')
  const [mode, setMode] = useState<TrendMode>('live')
  const [query, setQuery] = useState('')
  const [windowDays, setWindowDays] = useState(7)
  const [enableAi, setEnableAi] = useState(true)
  const [useWeb, setUseWeb] = useState(true)
  const [useModuleContext, setUseModuleContext] = useState(true)
  const [remember, setRemember] = useState(true)
  const [revision, setRevision] = useState(0)
  const [capabilities, setCapabilities] = useState<TrendCapabilities | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [report, setReport] = useState<TrendReport | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<ResearchProgress | undefined>()
  const [plan, setPlan] = useState<ResearchPlan | undefined>()
  const [steps, setSteps] = useState<ToolTrace[]>([])
  const [busy, setBusy] = useState(false)
  const running = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getCapabilities(controller.signal).then((value) => { setCapabilities(value); setConnectionError('') }).catch(() => {
      if (!controller.signal.aborted) setConnectionError('Служба поиска недоступна. Запустите backend и откройте раздел снова.')
    })
    return () => { controller.abort(); running.current?.abort() }
  }, [])

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 125000)
    setBusy(true)
    setError('')
    setReport(null)
    setProgress({ stage: 'prepare', message: 'Обновляем контекст разделов' })
    setPlan(undefined)
    setSteps([])
    try {
      if (useModuleContext) {
        const contexts = await collectModuleContexts()
        await Promise.all(contexts.map((context) => saveModuleContext(context, controller.signal)))
      }
      const value = await streamResearch({ domain, query, windowDays, mode, limit: 6, enableAi: enableAi && Boolean(capabilities?.agent?.configured), useWeb: mode === 'live' && useWeb, strategy: 'agent', profileId: 'default', useModuleContext, remember }, controller.signal, (event) => {
        setProgress(event)
        if (event.plan) setPlan(event.plan)
        if (event.step) setSteps((previous) => [...previous, event.step!])
      })
      setReport(value)
      setRevision((value) => value + 1)
      setConnectionError('')
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось выполнить поиск.')
      else setError('Исследование остановлено. Незавершённый отчёт не сохраняется.')
    } finally { window.clearTimeout(timeout); setBusy(false) }
  }

  async function discuss() {
    if (!report) return
    setOpeningChat(true); setError('')
    try { const conversation = await createConversation(report.id); setChatId(conversation.id); setView('chat') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось начать обсуждение') }
    finally { setOpeningChat(false) }
  }

  return (
    <>
      <header className="trend-header">
        <div><p className="eyebrow">Общие инструменты</p><h1 className="screen-title">Поиск трендов</h1><p className="body-2">Обсуждайте темы, уточняйте запросы и проверяйте источники вместе с исследователем.</p></div>
        <span className="quiet-badge">Персональный исследователь</span>
      </header>

      <div className="trend-mode-tabs" role="tablist" aria-label="Режим поиска трендов"><button type="button" role="tab" id="trend-chat-tab" aria-controls="trend-chat-panel" aria-selected={view === 'chat'} onClick={() => setView('chat')}>Чат</button><button type="button" role="tab" id="trend-research-tab" aria-controls="trend-research-panel" aria-selected={view === 'research'} onClick={() => setView('research')}>Исследование</button></div>
      <div id="trend-chat-panel" role="tabpanel" aria-labelledby="trend-chat-tab" hidden={view !== 'chat'}><TrendChat onResearchComplete={() => setRevision((value) => value + 1)} capabilities={capabilities} openConversationId={chatId} onReport={(value) => { setReport(value); setView('research') }} /></div>
      <div id="trend-research-panel" role="tabpanel" aria-labelledby="trend-research-tab" hidden={view !== 'research'}>
      <ResearchMemory revision={revision} onLoad={setReport} />

      <form className="research-form" onSubmit={search} aria-busy={busy}>
        <fieldset disabled={busy}>
          <legend className="visually-hidden">Параметры исследования</legend>
          <div className="mode-row">
            <div className="mode-switch" role="group" aria-label="Данные исследования">
              <button type="button" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>Демоданные</button>
              <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Живые источники</button>
            </div>
            <span className="form-caption">{mode === 'demo' ? 'Одинаковый учебный набор для всей команды' : 'RSS, веб-поиск и память исследований'}</span>
          </div>
          <div className="research-fields">
            <label className="query-field">Тема<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} placeholder="Например, силовые тренировки" /></label>
            <label>Область<select value={domain} onChange={(event) => setDomain(event.target.value as TrendDomain)}>{domains.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label>Период<select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}><option value={3}>3 дня</option><option value={7}>7 дней</option><option value={14}>14 дней</option><option value={30}>30 дней</option></select></label>
          </div>
          <div className="research-actions">
            <div className="research-options"><label className="ai-toggle"><input type="checkbox" checked={useModuleContext} onChange={(event) => setUseModuleContext(event.target.checked)} /><span>Учитывать данные разделов</span></label><label className="ai-toggle"><input type="checkbox" checked={useWeb} disabled={mode !== 'live'} onChange={(event) => setUseWeb(event.target.checked)} /><span>Искать в интернете</span></label><label className="ai-toggle"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Сохранить в память</span></label><label className="ai-toggle"><input type="checkbox" checked={enableAi && Boolean(capabilities?.agent?.configured)} disabled={!capabilities?.agent?.configured} onChange={(event) => setEnableAi(event.target.checked)} /><span>Агент с моделью</span><span className="form-caption">{capabilities?.ai.configured ? `${capabilities.ai.provider === 'runpod' ? 'Runpod' : capabilities.ai.provider === 'openrouter' ? 'OpenRouter' : 'Ollama'} настроен на сервере` : 'Без LLM: сценарий инструментов'}</span></label></div>
            <button className="primary-button" type="submit">{busy ? 'Исследуем…' : 'Запустить исследование'}<span aria-hidden="true">↗</span></button>
          </div>
        </fieldset>
      </form>

      {connectionError && !report ? <p className="notice error-notice" role="status">{connectionError}</p> : null}
      {error ? <p className="notice error-notice" role="alert">{error}</p> : null}
      <div aria-live="polite" aria-busy={busy}>
        {busy ? <ResearchBrief plan={plan} progress={progress} quality={progress?.quality} steps={steps} onCancel={() => running.current?.abort()} /> : null}
        {!busy && !report && !error ? <div className="search-empty"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 36 20 23l8 6 13-18M29 11h12v12" /></svg><h2>Сначала — тема, затем — доказательства</h2><p>Запустите исследование. Покажем публикации и изменение числа упоминаний за два равных периода.</p></div> : null}
        {report ? (
          <div className="research-results">
            <div className="result-heading"><h2>Результат исследования</h2><span className="mono">{domains.find((item) => item.id === report.request.domain)?.label} · {report.request.windowDays} дн. · {dateLabel(report.referenceTime)}</span></div>
            <button type="button" className="secondary-button" disabled={openingChat} onClick={discuss}>{openingChat ? 'Открываем чат…' : 'Обсудить этот отчёт в чате ↗'}</button>
            {!report.request.remember ? <p className="form-caption">Переход в чат доступен для сохранённых отчётов. Новые исследования внутри чата сохраняются автоматически.</p> : null}
            {report.request.query ? <p className="result-query">Тема: {report.request.query}</p> : null}
            <div className="result-stats">
              <div><span className="stat-value">{report.trends.length}</span><span>тем</span></div>
              <div><span className="stat-value">{report.articles.length}</span><span>датированных публикаций</span></div><div><span className="stat-value">{report.webResults?.length || 0}</span><span>веб-материалов</span></div>
              <div><span className="stat-value">{report.sources.filter((source) => source.status === 'ok').length}/{report.sources.length}</span><span>лент загружено</span></div>
            </div>
            {report.warnings.map((warning) => <p className="notice" key={warning}>{warning}</p>)}
            <AgentResults key={report.id} report={report} onFeedback={() => setRevision((value) => value + 1)} />
            {report.analysis.status === 'ready' ? <section className="analysis-panel"><p className="eyebrow">AI-разбор · {report.analysis.provider}</p><p>{report.analysis.summary}</p></section> : null}
            {report.analysis.status === 'unavailable' ? <p className="notice error-notice">{report.analysis.error}</p> : null}
            {!report.trends.length ? <div className="module-empty"><h3 className="empty-heading">{report.webResults?.length ? 'Расчётный сигнал роста не подтверждён' : 'Подходящих материалов нет'}</h3><p className="empty-copy">{report.webResults?.length ? 'Обзор найденных материалов доступен ниже. Для роста нужна датированная выборка за два периода.' : 'Измените запрос, область или период.'}</p></div> : null}
            <div className="trend-grid">{report.trends.map((trend) => {
              const evidence = report.articles.filter((article) => trend.evidenceIds.includes(article.id))
              const insight = report.analysis.insights?.find((item) => item.trendId === trend.id)
              return <article className="trend-card" key={trend.id}>
                <div className="trend-card-top"><span className={`signal-badge ${trend.signal}`}>{signalLabels[trend.signal]}</span><span className="mono">{trend.growthPercent === null ? 'нет базы' : `${trend.growthPercent > 0 ? '+' : ''}${trend.growthPercent}%`}</span></div>
                <h3>{trend.title}</h3>
                <p className="trend-counts">{trend.currentMentions} упоминаний сейчас · {trend.previousMentions} ранее · {trend.sourceCount} издателей сейчас</p>
                {insight ? <p className="trend-explanation">{insight.explanation}</p> : null}
                <details><summary>Публикации и основания ({evidence.length})</summary><ul className="evidence-list">{evidence.map((article) => <li key={article.id}><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<span aria-hidden="true"> ↗</span></a><span className="mono">{article.sourceName} · {dateLabel(article.publishedAt)}{insight?.evidenceIds.includes(article.id) ? ' · ссылка AI-разбора' : ''}</span></li>)}</ul></details>
              </article>
            })}</div>
            <RecentArticles report={report} />
            <details className="source-details"><summary>Состояние источников</summary><ul>{report.sources.map((source) => <li key={source.sourceId}><span>{source.name}</span><span className="mono">{source.status === 'ok' ? `${source.articleCount} публикаций${source.cached ? ' · кэш' : ''}` : source.error}</span></li>)}</ul></details>
          </div>
        ) : null}
      </div>
      </div>
    </>
  )
}
