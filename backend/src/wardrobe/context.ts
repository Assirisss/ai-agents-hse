import type { AgentMessage } from '../trends/planner.js'
import { compactContext } from '../trends/context.js'

// Conservative for Russian text; the server reserves space for tools and completion.
export function estimateTokens(text: string) { return Math.ceil([...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? .3 : 1), 0)) }

export function wardrobeHistory(history: { role: 'user' | 'assistant'; content: string }[]): AgentMessage[] {
  const selected: AgentMessage[] = []
  let tokens = 0
  for (const item of [...history].reverse()) {
    let content = item.content.slice(0, 3500)
    if (!selected.length && estimateTokens(content) > 2400) content = content.slice(0, 1000) + '\n…\n' + content.slice(-1000)
    const count = estimateTokens(content)
    if (tokens + count > 2600) break
    tokens += count
    selected.unshift({ role: item.role, content })
  }
  return selected
}

/** Keep valid JSON and complete assistant/tool groups when reducing repeated reads. */
export function wardrobeModelContext(messages: AgentMessage[]): AgentMessage[] {
  const compact = messages.map(message => {
    if (message.role !== 'tool' || message.content.length <= 4500) return message
    return { ...message, content: JSON.stringify(compactContext(JSON.parse(message.content), 4500)) }
  })
  const tokens = () => estimateTokens(JSON.stringify(compact))
  while (tokens() > 8500) {
    const groups = compact.flatMap((message, index) => message.role === 'assistant' && message.tool_calls?.length ? [index] : [])
    if (groups.length < 2) break
    const first = groups[0]
    let count = 1
    while (compact[first + count]?.role === 'tool') count++
    compact.splice(first, count)
  }
  for (const budget of [1200, 600, 300]) {
    if (tokens() <= 8500) break
    for (const message of compact) if (message.role === 'tool') message.content = JSON.stringify(compactContext(JSON.parse(message.content), budget))
  }
  if (tokens() > 8500) {
    const current = compact.findLastIndex(message => message.role === 'user')
    if (current > 1) compact.splice(1, current - 1)
  }
  return compact
}
