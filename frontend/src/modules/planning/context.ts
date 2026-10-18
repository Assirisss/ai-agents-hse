import { createContext, useContext } from 'react'
import type { CalendarProvider, ConnectedCalendar, PlanningCapabilities, PlanningSettings } from '../../../../shared/planning'

export type CalendarOption = ConnectedCalendar & { provider: CalendarProvider; accountLabel: string }
export type EditorTarget = { mode: 'create'; date: string } | { mode: 'edit'; eventId: string; occurrenceStart?: string }

export type PlanningContextValue = {
  settings: PlanningSettings
  capabilities: PlanningCapabilities | null
  calendars: CalendarOption[]
  today: string
  /** Current time, refreshed every minute; render code must not call Date.now(). */
  now: number
  /** Increments after any change, so views reload their data. */
  revision: number
  refresh: () => void
  openEditor: (target: EditorTarget) => void
}

export const PlanningContext = createContext<PlanningContextValue | null>(null)
export function usePlanning() {
  const value = useContext(PlanningContext)
  if (!value) throw new Error('PlanningContext is missing')
  return value
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие'
