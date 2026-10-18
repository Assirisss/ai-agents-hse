import { expect, test, type Page } from '@playwright/test'
import type { Draft, DraftInput, FinanceState } from '../../shared/finance.ts'

/** Every API request is intercepted; this suite never reads or writes personal data. */
async function fixture(page: Page) {
  const draft: Draft = {
    id: '00000000-0000-4000-8000-000000000001', revision: 0, kind: 'expense', amount: 85_000,
    date: '2026-10-19', accountId: 'cash', categoryId: 'food', description: 'Тестовый обед',
    source: 'form', status: 'pending', createdAt: '2026-10-19T09:00:00Z', missing: [], warnings: [],
  }
  const state: FinanceState = {
    accounts: [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 0, balance: 0, archived: false }],
    categories: [{ id: 'food', name: 'Продукты', kind: 'expense' }], drafts: [draft], operations: [],
    watchlist: [], summaries: [], deliveries: [], telegram: null, capabilities: { text: false, vision: false, telegram: false },
  }
  const patches: (DraftInput & { expectedRevision: number })[] = []
  const confirmations: { expectedRevision: number }[] = []
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === '/api/finance/state') return route.fulfill({ json: state })
    if (path === '/api/finance/stats') return route.fulfill({ json: {
      from: '2026-10-01', to: '2026-10-19', income: 0, expense: 0, net: 0,
      previousIncome: 0, previousExpense: 0, expenseByCategory: [],
    } })
    if (path === `/api/finance/drafts/${draft.id}` && request.method() === 'PATCH') {
      const input = request.postDataJSON() as DraftInput & { expectedRevision: number }
      patches.push(input)
      if (input.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: { error: 'Черновик изменился. Обновите данные и проверьте поля.' } })
      const { expectedRevision, ...fields } = input
      Object.assign(draft, fields, { revision: expectedRevision + 1 })
      return route.fulfill({ json: draft })
    }
    if (path === `/api/finance/drafts/${draft.id}/confirm`) {
      const input = request.postDataJSON() as { expectedRevision: number }
      confirmations.push(input)
      if (input.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: { error: 'Черновик изменился. Обновите данные и проверьте поля.' } })
      draft.status = 'confirmed'
      return route.fulfill({ json: { id: 'test-operation' } })
    }
    if (path === '/api/finance/chat/conversations' || path === '/api/finance/payments') return route.fulfill({ json: [] })
    return route.fulfill({ status: 503, json: { error: 'Изолированная браузерная проверка' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Финансы', exact: true }).click()
  await page.getByRole('button', { name: /Черновики и чеки/ }).click()
  const amount = page.getByLabel('Сумма, ₽', { exact: true }).filter({ visible: true })
  await expect(amount).toHaveValue('850,00')
  const refresh = async () => {
    await page.getByRole('button', { name: 'Обновить данные', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Обновить данные', exact: true })).toBeEnabled()
  }
  const externalEdit = (amount: number) => { draft.amount = amount; draft.revision = (draft.revision ?? 0) + 1 }
  return { draft, patches, confirmations, amount, refresh, externalEdit }
}

test('refresh updates pristine fields; confirmation posts exactly the displayed version without a PATCH', async ({ page }) => {
  const f = await fixture(page)
  f.externalEdit(850_000)
  await f.refresh()
  await expect(f.amount).toHaveValue('8500,00')
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click()
  await expect(page.getByText('Операция записана. Остатки и статистика обновлены.', { exact: true })).toBeVisible()
  expect(f.patches).toHaveLength(0)
  expect(f.confirmations).toEqual([{ expectedRevision: 1 }])
  expect(f.draft.amount).toBe(850_000)
})

test('refresh preserves unsaved edits, blocks writes on conflict and lets the user load current fields', async ({ page }) => {
  const f = await fixture(page)
  await f.amount.fill('1000,00')
  f.externalEdit(850_000)
  await f.refresh()
  await expect(f.amount).toHaveValue('1000,00')
  await expect(page.getByRole('button', { name: 'Сохранить поля', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Подтвердить запись', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Загрузить актуальные поля', exact: true }).click()
  await expect(f.amount).toHaveValue('8500,00')
  await f.amount.fill('9000,00')
  await expect(page.getByRole('button', { name: 'Подтвердить запись', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Сохранить поля', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Подтвердить запись', exact: true })).toBeEnabled()
  expect(f.patches[0]?.expectedRevision).toBe(1)
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click()
  await expect(page.getByText('Операция записана. Остатки и статистика обновлены.', { exact: true })).toBeVisible()
  expect(f.confirmations).toEqual([{ expectedRevision: 2 }])
  expect(f.draft.amount).toBe(900_000)
})

test('a save from an unrefreshed form uses its old revision and surfaces a conflict', async ({ page }) => {
  const f = await fixture(page)
  await f.amount.fill('1000,00')
  f.externalEdit(850_000)
  await page.getByRole('button', { name: 'Сохранить поля', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Черновик изменился.' })).toBeVisible()
  expect(f.patches[0]?.expectedRevision).toBe(0)
  expect(f.draft.amount).toBe(850_000)
  expect(f.confirmations).toHaveLength(0)
})

test('a stale confirmation is rejected without overwriting the externally changed draft', async ({ page }) => {
  const f = await fixture(page)
  f.externalEdit(850_000)
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Черновик изменился.' })).toBeVisible()
  expect(f.patches).toHaveLength(0)
  expect(f.confirmations).toEqual([{ expectedRevision: 0 }])
  expect(f.draft.status).toBe('pending')
  expect(f.draft.amount).toBe(850_000)
})
