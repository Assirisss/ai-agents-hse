export type FinanceAction = (label: string, action: (signal: AbortSignal) => Promise<unknown>, success?: string, options?: { timeoutMs?: number }) => Promise<boolean>
