import type { Evidence, TrendDomain } from '../../../shared/trends.js'

// Synthetic teaching data: never present these records as real news.
export const demoReferenceTime = '2026-10-17T12:00:00.000Z'
const subjects: { domain: Exclude<TrendDomain, 'all'>; subject: string; keyword: string }[] = [
  { domain: 'finance', subject: 'Процентные ставки', keyword: 'interest rate / инфляция' },
  { domain: 'health', subject: 'Силовые тренировки', keyword: 'strength / силовые тренировки' },
  { domain: 'health', subject: 'Питание и белок', keyword: 'nutrition / белок' },
  { domain: 'wardrobe', subject: 'Гардероб и материалы', keyword: 'wardrobe / гардероб' },
  { domain: 'planning', subject: 'Организация дел', keyword: 'planning / задачи' },
]

export function demoArticles(domain: TrendDomain): Evidence[] {
  const now = Date.parse(demoReferenceTime)
  return subjects.filter((subject) => domain === 'all' || subject.domain === domain).flatMap((subject) =>
    [1, 2, 3, 4, 5, 6, 9, 11].map((daysAgo, index) => ({
      id: `demo-${subject.domain}-${subject.keyword.split(' ')[0]}-${index}`,
      sourceId: `demo-${index % 3}`,
      publisherId: `demo-${index % 3}`,
      sourceName: `Учебный источник ${index % 3 + 1}`,
      title: `[Демо] ${subject.subject}: пример публикации ${index + 1}`,
      url: `https://example.com/demo/${subject.domain}/${encodeURIComponent(subject.subject)}/${index}`,
      publishedAt: new Date(now - daysAgo * 86400000).toISOString(),
      snippet: `Искусственный материал для проверки группировки по теме ${subject.keyword}. Это не реальная публикация и не подтверждение существования тренда.`,
    })),
  )
}
