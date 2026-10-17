import type { TrendDomain, TrendSource } from '../../../shared/trends.js'

/** Server-owned allowlist. Clients select domains, never supply fetch URLs. */
export const sources: TrendSource[] = [
  { id: 'ecb', name: 'European Central Bank', publisherId: 'ecb', url: 'https://www.ecb.europa.eu/rss/press.html', domains: ['finance'] },
  { id: 'science-fitness', name: 'ScienceDaily · Fitness', publisherId: 'sciencedaily', url: 'https://www.sciencedaily.com/rss/health_medicine/fitness.xml', domains: ['health'] },
  { id: 'science-nutrition', name: 'ScienceDaily · Nutrition', publisherId: 'sciencedaily', url: 'https://www.sciencedaily.com/rss/health_medicine/nutrition.xml', domains: ['health'] },
  { id: 'vogue', name: 'Vogue', publisherId: 'vogue', url: 'https://www.vogue.com/feed/rss', domains: ['wardrobe'] },
]

export type Topic = { id: string; title: string; domains: TrendDomain[]; terms: string[] }
export const topics: Topic[] = [
  { id: 'rates', title: 'Процентные ставки и инфляция', domains: ['finance'], terms: ['interest rate', 'monetary policy', 'inflation', 'ставк', 'инфляц'] },
  { id: 'assets', title: 'Активы и инвестиции', domains: ['finance'], terms: ['invest', 'bond', 'equity', 'portfolio', 'инвест', 'облигац', 'портфел'] },
  { id: 'strength', title: 'Силовые тренировки', domains: ['health'], terms: ['strength', 'resistance training', 'muscle', 'силов', 'мышц'] },
  { id: 'recovery', title: 'Восстановление и сон', domains: ['health'], terms: ['sleep', 'recovery', 'восстанов', 'сон', 'сна'] },
  { id: 'nutrition', title: 'Питание и белок', domains: ['health'], terms: ['nutrition', 'protein', 'diet', 'питан', 'белок', 'белка', 'рацион'] },
  { id: 'fashion', title: 'Коллекции и сочетания', domains: ['wardrobe'], terms: ['fashion', 'runway', 'collection', 'style', 'мод', 'коллекц', 'образ'] },
  { id: 'wardrobe', title: 'Гардероб и материалы', domains: ['wardrobe'], terms: ['wardrobe', 'fabric', 'denim', 'гардероб', 'ткан', 'джинс'] },
  { id: 'planning', title: 'Организация дел', domains: ['planning'], terms: ['productivity', 'planning', 'task', 'планир', 'задач'] },
]
