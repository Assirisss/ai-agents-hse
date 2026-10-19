/** Finance contracts: all money is integer RUB kopecks; dates are YYYY-MM-DD. */
export type OperationKind = 'income' | 'expense' | 'transfer'
export type Account = { id: string; name: string; currency: 'RUB'; initialBalance: number; balance: number; archived: boolean }
export type Category = { id: string; name: string; kind: 'income' | 'expense' }
export type ReceiptItem = { name: string; quantity: number | null; total: number | null }
export type OperationInput = { kind: OperationKind; amount: number; date: string; accountId: string; destinationAccountId?: string | null; categoryId?: string | null; description: string }
/** Legacy stored operations without revision are version 0. */
export type Operation = OperationInput & { id: string; revision?: number; status: 'posted' | 'cancelled'; createdAt: string; updatedAt: string; receiptId?: string | null }
export type DraftInput = { kind?: OperationKind | null; amount?: number | null; date?: string | null; accountId?: string | null; destinationAccountId?: string | null; categoryId?: string | null; description?: string; receiptId?: string | null; items?: ReceiptItem[]; warnings?: string[]; provenance?: Partial<Record<DraftField, FieldProvenance>> }
/** Legacy stored drafts without revision are version 0. */
export type Draft = DraftInput & { id: string; revision?: number; status: 'pending' | 'confirmed' | 'cancelled'; source: 'form' | 'text' | 'receipt'; createdAt: string; operationId?: string | null; missing: string[]; warnings: string[] }
export type Receipt = { id: string; filename: string; mime: string; hash: string; createdAt: string; duplicate: boolean }
export type AuditEntry = { id: string; entityId: string; action: string; before: unknown; after: unknown; createdAt: string }
export type FinanceStats = { from: string; to: string; income: number; expense: number; net: number; previousIncome: number; previousExpense: number; expenseByCategory: { categoryId: string | null; name: string; amount: number }[] }
export type Instrument = { ticker: string; name: string }
export type Quote = { ticker: string; name: string; price: string | null; previousClose: string | null; change: string | null; changePercent: string | null; currency: 'RUB'; tradedAt: string | null; fetchedAt: string; sourceUrl: string; stale: boolean; error?: string }
export type MarketSummary = { id: string; date: string; generatedAt: string; quotes: Quote[]; text: string }
export type Delivery = { id: string; date: string; status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain'; attempts: number; error?: string | null; updatedAt: string }
export type TelegramBinding = { chatId: string; userId: string; linkedAt: string }
export type FinanceState = { accounts: Account[]; categories: Category[]; operations: Operation[]; drafts: Draft[]; watchlist: Instrument[]; summaries: MarketSummary[]; telegram: TelegramBinding | null; deliveries: Delivery[]; capabilities: { text: boolean; vision: boolean; telegram: boolean } }
export type AgentReply = { text: string; draft?: Draft; steps: { tool: string; status: 'ok' | 'error' }[]; evidence?: FinanceEvidence[]; filter?: OperationFilter; method?: 'rules' | 'model' | 'mixed' }
export type FinanceSnapshot = Omit<FinanceState, 'capabilities'> & { receipts: Receipt[]; audit: AuditEntry[]; telegramPendingDraftId?: string | null; telegramConversationId?: string | null; conversations: FinanceConversation[]; turns: FinanceTurn[]; payments: Payment[]; paymentDeliveries: Delivery[] }
export type FinanceDocument = { profileId: string; value: FinanceSnapshot }

export type DraftField = 'kind' | 'amount' | 'date' | 'accountId' | 'destinationAccountId' | 'categoryId' | 'description'
export type FieldProvenance = { method: 'manual' | 'rule' | 'model' | 'receipt'; excerpt?: string; note?: string }
export type OperationFilter = { from?: string; to?: string; kind?: OperationKind; accountId?: string; categoryId?: string; query?: string }
export type FinanceEvidence = { label: string; filter: OperationFilter; operationIds: string[]; count: number }
export type FinanceMessage = { id: string; turnId: string; role: 'user' | 'assistant'; text: string; createdAt: string; reply?: AgentReply }
export type FinanceConversation = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; messages: FinanceMessage[]; activeDraftId: string | null; filter: OperationFilter }
export type FinanceConversationSummary = Pick<FinanceConversation, 'id' | 'title' | 'revision' | 'updatedAt'>
export type FinanceChatRequest = { turnId: string; expectedRevision: number; text: string }
export type FinanceChatResult = { conversation: FinanceConversation; messageId: string; replayed: boolean }
export type FinanceChatProgress = { message: string }
export type FinanceChatEvent = { type: 'progress'; progress: FinanceChatProgress } | { type: 'result'; result: FinanceChatResult } | { type: 'error'; error: string; conflict?: boolean }
export type FinanceTurn = { id: string; conversationId: string; fingerprint: string; messageId: string }
export type PaymentInput = { title: string; amount: number | null; dueDate: string; time: string; rrule: string | null; accountId?: string | null; categoryId?: string | null }
export type Payment = PaymentInput & { id: string; planningTaskId: string; status: 'active' | 'cancelled'; syncStatus: 'pending' | 'synced' | 'error'; error?: string | null; createdAt: string; updatedAt: string }
