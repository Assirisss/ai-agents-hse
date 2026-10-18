export type FinanceAction = (label: string, action: (signal: AbortSignal) => Promise<unknown>, success?: string) => Promise<boolean>
