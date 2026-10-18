import { registerModuleContextAdapter } from '../trends/moduleContext'

/** Planning shares only aggregated counts with trend research: no titles, notes or places. */
registerModuleContextAdapter(async () => {
  try {
    const response = await fetch('/api/planning/context')
    if (!response.ok) return null
    const value = await response.json() as { module: 'planning'; source: string; facts: string[] }
    return { module: 'planning', source: value.source, facts: value.facts.slice(0, 30) }
  } catch { return null }
})
