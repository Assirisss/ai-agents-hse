import type { Evidence, Relevance, TrendProfile, WebFinding } from '../../../shared/trends.js'
import { words, type TrendMemory } from './memory.js'
import { topics } from './catalog.js'

function concepts(value: string): string[] {
  const lower = value.toLocaleLowerCase()
  return [...words(value), ...topics.filter((topic) => topic.terms.some((term) => lower.includes(term))).flatMap((topic) => topic.terms)]
}

export function relevance(item: { title: string; snippet: string; url: string; text?: string }, profile: TrendProfile, memory: TrendMemory, mode: string): Relevance {
  const text = `${item.title} ${item.snippet} ${item.text || ''}`.toLocaleLowerCase()
  const interests = profile.interests.filter((interest) => concepts(interest).some((term) => text.includes(term)))
  const goals = profile.goals.filter((goal) => concepts(goal).some((term) => text.includes(term)))
  const contextMatch = profile.context.some((fact) => concepts(fact).some((term) => text.includes(term)))
  const excluded = profile.excludedTopics.some((topic) => text.includes(topic.toLocaleLowerCase()))
  const verdict = memory.verdict(profile.id, item.url)
  const seenBefore = memory.seen(profile.id, item.url, mode)
  const reasons = [
    ...interests.slice(0, 2).map((interest) => `Интерес: ${interest}`),
    ...(contextMatch ? ['Совпадение с контекстом профиля или разделов'] : []),
    ...(goals.length ? ['Связано с указанной целью'] : []),
    ...(verdict === 'useful' ? ['Ранее отмечено полезным'] : []),
    ...(seenBefore ? ['Уже встречалось в прошлых исследованиях'] : []),
  ]
  return { score: excluded || verdict === 'not_useful' ? 0 : Math.min(100, Math.max(5, 40 + interests.length * 15 + goals.length * 10 + (contextMatch ? 5 : 0) + (verdict === 'useful' ? 20 : 0) - (seenBefore ? 10 : 0))), reasons, seenBefore }
}

export function personalizeWeb(items: WebFinding[], profile: TrendProfile, memory: TrendMemory, mode: string): WebFinding[] {
  return items.map((item) => ({ ...item, relevance: relevance(item, profile, memory, mode) }))
    .filter((item) => item.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score)
}
export function filterEvidence(items: Evidence[], profile: TrendProfile, memory: TrendMemory, mode: string): Evidence[] {
  return items.filter((item) => relevance(item, profile, memory, mode).score > 0)
}
