import { FinanceError } from './schema.js'

function integerMoney(value: number) {
  if (!Number.isSafeInteger(value)) throw new FinanceError('Сумма выходит за допустимую точность')
  return BigInt(value)
}

/** Decimal conversion never divides a Number: safe kopecks can exceed precise decimal RUB. */
export function decimalRubles(value: number): string {
  const amount = integerMoney(value), absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

export function formatMoney(value: number): string {
  const amount = integerMoney(value), absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '−' : ''}${(absolute / 100n).toLocaleString('ru-RU')},${String(absolute % 100n).padStart(2, '0')} ₽`
}

/** Bound the final sum only after accumulating with integer precision. */
export function sumKopecks(values: Iterable<number>): number {
  let sum = 0n
  for (const value of values) sum += integerMoney(value)
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new FinanceError('Сумма выходит за допустимую точность')
  return Number(sum)
}
