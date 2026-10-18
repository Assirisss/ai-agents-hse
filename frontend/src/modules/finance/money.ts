/** Parse decimal RUB directly to integer kopecks without binary floating point rounding. */
export function parseMoney(value: string, allowNegative = false): number {
  const compact = value.trim().replace(/[\s\u00a0\u202f]/g, '')
  if (!(allowNegative ? /^-?\d+(?:[.,]\d{1,2})?$/ : /^\d+(?:[.,]\d{1,2})?$/).test(compact)) {
    throw new Error('Введите сумму в рублях: например, 1250,50. Не больше двух знаков после запятой.')
  }
  const negative = compact.startsWith('-')
  const [rubles, fraction = ''] = compact.replace(/^-/, '').split(/[.,]/)
  const result = (BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n)
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Сумма слишком большая.')
  return Number(result)
}

export function moneyInput(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const amount = BigInt(value)
  const absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '-' : ''}${absolute / 100n},${String(absolute % 100n).padStart(2, '0')}`
}

export function money(value: number): string {
  const amount = BigInt(value)
  const absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '−' : ''}${(absolute / 100n).toLocaleString('ru-RU')},${String(absolute % 100n).padStart(2, '0')} ₽`
}

export function moscowToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-')
}
