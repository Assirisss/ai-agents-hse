import type { ResearchProgress } from '../../../shared/trends.js'
export type ResearchRuntime = { signal?: AbortSignal; onProgress?: (progress: ResearchProgress) => void }
export const researchBudget = { modelCalls: 8, toolCalls: 12, searches: 3, reads: 4, durationMs: 105000 } as const
export function emitProgress(runtime: ResearchRuntime, progress: ResearchProgress) {
  try { runtime.onProgress?.(progress) } catch { /* Observability never changes the research result. */ }
}
