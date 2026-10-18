import { useState, type FormEvent } from 'react'
import type { FinanceState, Instrument } from '../../../../shared/finance'
import { financeRequest, requestSummary, searchInstruments } from './api'
import type { FinanceAction } from './types'

export default function Market({ data, busy, run }: { data: FinanceState; busy: boolean; run: FinanceAction }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Instrument[] | null>(null)
  const [summaryId, setSummaryId] = useState('')
  const summaries = [...data.summaries].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
  const summary = summaries.find((item) => item.id === summaryId) ?? summaries[0]

  function search(event: FormEvent) {
    event.preventDefault()
    void run('Ищем бумаги на MOEX', async (signal) => { const instruments = await searchInstruments(query.trim(), signal); if (!signal.aborted) setResults(instruments) })
  }

  return <>
    <section className="finance-panel"><div className="finance-section-heading"><div><h2>Список наблюдения</h2><p className="finance-caption">Акции Московской биржи · TQBR · до 10 бумаг</p></div><span className="finance-badge">{data.watchlist.length} / 10</span></div><form className="finance-search" onSubmit={search}><label>Тикер или название<input value={query} maxLength={100} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Например, SBER" /></label><button className="finance-button" type="submit" disabled={busy}>Найти на MOEX</button></form>{results ? <div className="finance-search-results">{results.length ? results.map((item) => <div key={item.ticker}><span><strong>{item.ticker}</strong> · {item.name}</span><button className="finance-link-button" disabled={busy || data.watchlist.length >= 10 || data.watchlist.some((watch) => watch.ticker === item.ticker)} onClick={() => { void run('Добавляем бумагу', (signal) => financeRequest('/watchlist', signal, 'POST', { ticker: item.ticker }), 'Бумага добавлена в список наблюдения.') }}>{data.watchlist.some((watch) => watch.ticker === item.ticker) ? 'Уже в списке' : 'Добавить'}</button></div>) : <p className="finance-caption">Бумаги не найдены. Попробуйте другой тикер или название.</p>}</div> : null}<ul className="finance-watchlist">{data.watchlist.map((item) => <li key={item.ticker}><div><strong>{item.ticker}</strong><span>{item.name}</span></div><button className="finance-link-button" disabled={busy} onClick={() => { void run('Удаляем бумагу из списка', (signal) => financeRequest(`/watchlist/${encodeURIComponent(item.ticker)}`, signal, 'DELETE'), 'Бумага удалена из списка наблюдения.') }}>Убрать</button></li>)}</ul>{!data.watchlist.length ? <p className="finance-empty">Добавьте бумаги, по которым хотите получать котировки. Начальный список пуст.</p> : null}</section>
    <section className="finance-panel"><div className="finance-section-heading"><div><h2>Сводка котировок</h2><p className="finance-caption">Ежедневно в 21:00 МСК в привязанный Telegram. Backend и worker должны работать.</p></div><button className="finance-button finance-primary" disabled={busy || !data.watchlist.length} onClick={() => { void run('Получаем котировки', async (signal) => { const result = await requestSummary(signal); if (!signal.aborted) setSummaryId(result.id) }, 'Сводка сохранена на сайте.') }}>Обновить сейчас</button></div><p className="finance-caption">Данные MOEX могут поступать с задержкой. Изменение рассчитано от предыдущего торгового закрытия. В выходные показывается последняя доступная торговая дата.</p>{summaries.length > 1 ? <label className="finance-summary-picker">Сохранённая сводка<select value={summary?.id ?? ''} onChange={(event) => setSummaryId(event.target.value)}>{summaries.map((item) => <option value={item.id} key={item.id}>{displayTime(item.generatedAt)}</option>)}</select></label> : null}
      {summary ? <><p className="finance-caption">Получено {displayTime(summary.generatedAt)} МСК</p><div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Бумага</th><th className="finance-number">Цена</th><th className="finance-number">Изменение</th><th>Дата данных</th></tr></thead><tbody>{summary.quotes.map((quote) => <tr key={quote.ticker}><td><a href={quote.sourceUrl} target="_blank" rel="noopener noreferrer">{quote.ticker} ↗</a><small>{quote.name}</small>{quote.error ? <small className="finance-negative">{quote.error}</small> : null}</td><td className="finance-number">{quote.price === null ? 'Нет данных' : `${quote.price.replace('.', ',')} ₽`}</td><td className="finance-number">{quote.change === null || quote.changePercent === null ? '—' : <>{quote.change.replace('.', ',')} ₽<small>{quote.changePercent.replace('.', ',')}%</small></>}</td><td>{quote.tradedAt ? displayTime(quote.tradedAt) : 'Не указана'}{quote.stale ? <small className="finance-warning">Последние доступные данные</small> : null}</td></tr>)}</tbody></table></div><details className="finance-summary-text"><summary>Текст сводки для Telegram</summary><p>{summary.text}</p></details></> : <p className="finance-empty">Сводок пока нет. Добавьте бумаги и запросите котировки.</p>}</section>
  </>
}

function displayTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
}
