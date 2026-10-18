import type { AgentFinancePort, OperationFilters } from './tools.js'
import type { FinanceService } from './service.js'
import type { Operation } from '../../../shared/finance.js'
export function filterOperations(operations: Operation[], filters: OperationFilters) {
  return operations.filter(item => item.status === 'posted' && (!filters.from || item.date >= filters.from) && (!filters.to || item.date <= filters.to) && (!filters.kind || item.kind === filters.kind) && (!filters.accountId || item.accountId === filters.accountId || item.destinationAccountId === filters.accountId) && (!filters.categoryId || item.categoryId === filters.categoryId) && (!filters.query || item.description.toLocaleLowerCase('ru-RU').includes(filters.query.toLocaleLowerCase('ru-RU'))))
}
export function financePort(finance: FinanceService, profileId: string): AgentFinancePort {
  return {
    accounts: async () => (await finance.state(profileId)).accounts,
    categories: async () => (await finance.state(profileId)).categories,
    drafts: async () => (await finance.state(profileId)).drafts.filter(draft => draft.status === 'pending'),
    operations: async filters => filterOperations((await finance.state(profileId)).operations, filters),
    stats: range => finance.stats(profileId, range.from, range.to),
    createDraft: (input, source) => finance.createDraft(profileId, input, source),
    updateDraft: (id, input) => finance.updateDraft(profileId, id, input),
  }
}
