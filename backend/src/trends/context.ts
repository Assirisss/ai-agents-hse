/** Shrink structured data without cutting JSON mid-record or turning source text into instructions. */
export function compactContext(value: unknown, maxLength = 12000): unknown {
  function project(input: unknown, stringLimit: number, arrayLimit: number, key = '', depth = 0): unknown {
    if (typeof input === 'string') return input.slice(0, key === 'text' ? stringLimit * 6 : stringLimit)
    if (depth > 12) return null
    if (Array.isArray(input)) return input.slice(0, arrayLimit).map((item) => project(item, stringLimit, arrayLimit, key, depth + 1))
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, project(item, stringLimit, arrayLimit, name, depth + 1)]))
    return input
  }
  for (const [strings, arrays] of [[750, 8], [400, 5], [200, 3], [100, 2]]) {
    const data = project(value, strings, arrays)
    if (JSON.stringify(data).length <= maxLength) return { data, truncated: JSON.stringify(data) !== JSON.stringify(value) }
  }
  return { data: null, truncated: true, note: 'Ответ слишком большой. Запросите более узкую выборку.' }
}
