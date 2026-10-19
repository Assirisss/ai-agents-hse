import { expect, test } from '@playwright/test'
import type { FinanceAnalysis, FinanceConversation, FinanceState, Operation } from '../../shared/finance.ts'

test('analysis shows facts, hypotheses and limitations; sources open exact operations and filters can be reset', async ({ page }) => {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()), timestamp = new Date().toISOString()
  const base: Operation = { id: 'op-1', kind: 'expense', amount: 85000, date, accountId: 'cash', categoryId: 'food', description: 'Покупка для анализа', status: 'posted', createdAt: timestamp, updatedAt: timestamp }
  const state: FinanceState = {
    accounts: [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 0, balance: -170000, archived: false }],
    categories: [{ id: 'food', name: 'Продукты', kind: 'expense' }], operations: [base, { ...base, id: 'op-2', description: 'Другая покупка' }],
    drafts: [], watchlist: [], summaries: [], deliveries: [], telegram: null, capabilities: { text: true, vision: false, telegram: false },
  }
  const link = { label: 'Проверить покупку', filter: { from: date, to: date, kind: 'expense' as const, categoryId: 'food', operationIds: ['op-1'] }, operationIds: ['op-1'], count: 1 }
  const analysis: FinanceAnalysis = {
    id: 'analysis-1', kind: 'changes', title: 'За счёт чего изменились расходы', period: { from: date, to: date },
    facts: [{ id: 'fact-1', type: 'fact', text: 'В категории «Продукты» учтено 1 700,00 ₽ расходов.', evidence: [link] }, { id: 'hypothesis-1', type: 'hypothesis', text: 'Возможная разовая покупка: характер покупки нужно подтвердить.', evidence: [] }],
    limitations: ['В предыдущем периоде недостаточно записей.'],
  }
  let conversation: FinanceConversation | null = null
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === '/api/finance/state') return route.fulfill({ json: state })
    if (path === '/api/finance/stats') return route.fulfill({ json: { from: date, to: date, income: 0, expense: 170000, net: -170000, previousIncome: 0, previousExpense: 0, expenseByCategory: [] } })
    if (path === '/api/finance/chat/conversations' && request.method() === 'GET') return route.fulfill({ json: conversation ? [conversation] : [] })
    if (path === '/api/finance/chat/conversations' && request.method() === 'POST') {
      conversation = { id: '00000000-0000-4000-8000-000000000003', title: 'Анализ', revision: 0, createdAt: timestamp, updatedAt: timestamp, messages: [], activeDraftId: null, filter: {} }
      return route.fulfill({ json: conversation })
    }
    if (path.endsWith('/messages/stream') && conversation) {
      const input = request.postDataJSON() as { turnId: string; text: string }
      conversation.messages.push({ id: 'user', role: 'user', text: input.text, turnId: input.turnId, createdAt: timestamp }, { id: 'answer', role: 'assistant', text: 'fallback text must not duplicate the report', turnId: input.turnId, createdAt: timestamp, reply: { text: 'fallback text must not duplicate the report', analysis, steps: [{ tool: 'finance_compare_expenses', status: 'ok' }, { tool: 'finance_explain_analysis', status: 'ok' }], method: 'mixed', evidence: [link] } })
      conversation.revision = 1
      return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'result', result: { conversation, messageId: 'answer', replayed: false } })}\n` })
    }
    if (conversation && path === `/api/finance/chat/conversations/${conversation.id}`) return route.fulfill({ json: conversation })
    if (path === '/api/finance/payments') return route.fulfill({ json: [] })
    return route.fulfill({ status: 503, json: { error: 'Изолированная проверка' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Финансы', exact: true }).click()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await page.getByRole('button', { name: 'Почему в этом месяце потратил больше?', exact: true }).click()
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Факты по учёту', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Предположения для проверки', exact: true })).toBeVisible()
  await expect(page.getByText('В предыдущем периоде недостаточно записей.', { exact: true })).toBeVisible()
  await expect(page.getByText('fallback text must not duplicate the report', { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Проверить покупку · операций: 1 ↗', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Операции · 1', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: /Другая покупка/ })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Категория', exact: true }).selectOption('all')
  await expect(page.getByRole('heading', { name: 'Операции · 2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'За счёт чего изменились расходы', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
