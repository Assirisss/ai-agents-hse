import { randomUUID } from 'node:crypto'
import type { Instrument, MarketSummary, Quote } from '../../../shared/finance.js'

const BASE = 'https://iss.moex.com/iss'
const BOARD = '/engines/stock/markets/shares/boards/TQBR/securities'
type IssTable = { columns: string[]; data: unknown[][] }
type IssResponse = Record<string, IssTable>
type Row = Record<string, unknown>
type MarketOptions = { fetch?: typeof fetch; now?: () => Date }

export function moscowDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function rows(table?: IssTable): Row[] {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.data)) return []
  return table.data.map(row => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])))
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
function decimal(value: number | null): string | null { return value === null ? null : value.toFixed(8).replace(/\.?0+$/, '') }
function signed(value: string | null): string { return value === null ? 'нет данных' : `${Number(value) > 0 ? '+' : ''}${value}` }
function validTicker(value: string): boolean { return /^[A-Z0-9]{1,12}$/.test(value) }

/** MOEX ISS, delayed public data; restricted to ordinary/preferred RUB shares on TQBR. */
export class MarketService {
  private readonly fetcher: typeof fetch
  private readonly now: () => Date
  private catalogue: { at: number; items: Instrument[] } | null = null

  constructor(options: MarketOptions = {}) { this.fetcher = options.fetch ?? fetch; this.now = options.now ?? (() => new Date()) }

  private async request(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<IssResponse> {
    const url = new URL(`${BASE}${path}.json`)
    url.searchParams.set('iss.meta', 'off')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    try {
      const response = await this.fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000), redirect: 'error' })
      if (!response.ok) throw new Error('upstream')
      return await response.json() as IssResponse
    } catch { throw new Error('Источник MOEX временно недоступен') }
  }

  async search(query: string, signal?: AbortSignal): Promise<Instrument[]> {
    if (!this.catalogue || this.now().getTime() - this.catalogue.at > 3_600_000) {
      const response = await this.request(BOARD, { 'iss.only': 'securities', 'securities.columns': 'SECID,SHORTNAME,SECNAME,SECTYPE,CURRENCYID' }, signal)
      const items = rows(response.securities).filter(row => validTicker(String(row.SECID)) && ['1', '2'].includes(String(row.SECTYPE)) && ['SUR', 'RUB'].includes(String(row.CURRENCYID)))
        .map(row => ({ ticker: String(row.SECID), name: String(row.SECNAME || row.SHORTNAME || row.SECID) }))
      this.catalogue = { at: this.now().getTime(), items }
    }
    const normalized = query.trim().toLocaleLowerCase('ru')
    return this.catalogue.items.filter(item => !normalized || `${item.ticker} ${item.name}`.toLocaleLowerCase('ru').includes(normalized)).slice(0, 50)
  }

  async instrument(ticker: string, signal?: AbortSignal): Promise<Instrument> {
    if (!validTicker(ticker)) throw new Error('Некорректный тикер')
    const found = (await this.search(ticker, signal)).find(item => item.ticker === ticker)
    if (!found) throw new Error('Выберите акцию в рублях из каталога MOEX TQBR')
    return found
  }

  private async history(ticker: string, signal?: AbortSignal): Promise<{ price: number; previous: number | null; at: string } | null> {
    const since = new Date(this.now().getTime() - 45 * 86_400_000)
    const response = await this.request(`/history${BOARD}/${ticker}`, { from: moscowDate(since), till: moscowDate(this.now()), 'iss.only': 'history', 'history.columns': 'TRADEDATE,LEGALCLOSEPRICE,CLOSE' }, signal)
    const values = rows(response.history).map(row => ({ price: number(row.LEGALCLOSEPRICE) ?? number(row.CLOSE), date: String(row.TRADEDATE ?? '') }))
      .filter((row): row is { price: number; date: string } => row.price !== null && /^\d{4}-\d{2}-\d{2}$/.test(row.date)).sort((a, b) => a.date.localeCompare(b.date))
    const latest = values.at(-1)
    return latest ? { price: latest.price, previous: values.at(-2)?.price ?? null, at: latest.date } : null
  }

  private async lastTrade(ticker: string, signal?: AbortSignal): Promise<{ price: number; at: string } | null> {
    try {
      const response = await this.request(`${BOARD}/${ticker}/trades`, { 'iss.only': 'trades', limit: '1', reversed: '1' }, signal)
      const trades = rows(response.trades).filter(row => row.SECID === ticker && row.BOARDID === 'TQBR').map(row => {
        // Unlike marketdata.SYSTIME (server time), a trade record's SYSTIME is
        // the date/time when that specific trade was registered by the source.
        const date = String(row.TRADEDATE ?? String(row.SYSTIME ?? '').slice(0, 10))
        const time = String(row.TRADETIME ?? '')
        const price = number(row.PRICE)
        return { price, at: /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time) ? `${date}T${time}+03:00` : null }
      }).filter((row): row is { price: number; at: string } => row.price !== null && row.at !== null).sort((a, b) => b.at.localeCompare(a.at))
      return trades[0] ?? null
    } catch { return null }
  }

  async quote(instrument: Instrument, cached?: Quote, signal?: AbortSignal): Promise<Quote> {
    if (!validTicker(instrument.ticker)) throw new Error('Некорректный тикер')
    const fetchedAt = this.now().toISOString()
    const sourceUrl = `https://www.moex.com/ru/issue.aspx?board=TQBR&code=${instrument.ticker}`
    try {
      const response = await this.request(`${BOARD}/${instrument.ticker}`, { 'iss.only': 'securities,marketdata' }, signal)
      const security = rows(response.securities).find(row => row.SECID === instrument.ticker)
      if (!security || !['1', '2'].includes(String(security.SECTYPE)) || !['SUR', 'RUB'].includes(String(security.CURRENCYID))) throw new Error('Акция недоступна на TQBR')
      const data = rows(response.marketdata).find(row => row.SECID === instrument.ticker)
      let price = number(data?.LAST)
      let previous = number(security.PREVLEGALCLOSEPRICE)
      const tradeDate = String(data?.TRADEDATE ?? '')
      const tradeTime = String(data?.TIME ?? '')
      let tradedAt = /^\d{4}-\d{2}-\d{2}$/.test(tradeDate) && /^\d{2}:\d{2}:\d{2}$/.test(tradeTime) ? `${tradeDate}T${tradeTime}+03:00` : null
      if (price === null || !tradedAt) {
        const trade = await this.lastTrade(instrument.ticker, signal)
        price = trade?.price ?? null; tradedAt = trade?.at ?? null
      }
      if (price === null || !tradedAt || tradedAt.slice(0, 10) !== moscowDate(this.now())) {
        const history = await this.history(instrument.ticker, signal)
        price = history?.price ?? null; previous = history?.previous ?? null; tradedAt = history?.at ?? null
      }
      const change = price !== null && previous !== null ? price - previous : null
      return { ticker: instrument.ticker, name: instrument.name, price: decimal(price), previousClose: decimal(previous), change: decimal(change), changePercent: decimal(change !== null && previous !== null ? change / previous * 100 : null), currency: 'RUB', tradedAt, fetchedAt, sourceUrl, stale: price === null || tradedAt === null || tradedAt.slice(0, 10) !== moscowDate(this.now()), ...(price === null ? { error: 'Нет доступной цены' } : {}) }
    } catch {
      return { ticker: instrument.ticker, name: instrument.name, price: cached?.price ?? null, previousClose: cached?.previousClose ?? null, change: cached?.change ?? null, changePercent: cached?.changePercent ?? null, currency: 'RUB', tradedAt: cached?.tradedAt ?? null, fetchedAt: cached?.fetchedAt ?? fetchedAt, sourceUrl, stale: true, error: 'Свежие данные MOEX недоступны' }
    }
  }

  async summary(watchlist: Instrument[], previousQuotes: Quote[] = [], signal?: AbortSignal): Promise<MarketSummary> {
    if (watchlist.length > 10) throw new Error('Можно отслеживать до 10 акций')
    const quotes = await Promise.all(watchlist.map(item => this.quote(item, previousQuotes.find(quote => quote.ticker === item.ticker), signal)))
    const date = moscowDate(this.now())
    const lines = quotes.map(quote => `${quote.name} (${quote.ticker}): ${quote.price === null ? 'цена недоступна' : `${quote.price} ₽`}\nИзменение к предыдущему торговому закрытию: ${signed(quote.change)} ₽ / ${signed(quote.changePercent)}%.\nДанные: ${quote.tradedAt ?? 'дата неизвестна'}${quote.stale ? ' · последняя доступная дата, свежих данных нет' : ''}${quote.error ? ` · ${quote.error}` : ''}\n${quote.sourceUrl}`)
    return { id: randomUUID(), date, generatedAt: this.now().toISOString(), quotes, text: [`MOEX TQBR · ${date}`, 'Публичные котировки предоставляются с задержкой.', ...lines.length ? lines : ['Список отслеживаемых акций пуст.']].join('\n\n') }
  }
}
