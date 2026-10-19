import { expect, test, type Page } from '@playwright/test'
import type { FinanceState, Operation, OperationInput } from '../../shared/finance.ts'

/** A shared fake server lets two browser pages race without touching personal finances. */
async function fixture(page: Page) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())
  const operation: Operation = {
    id: 'test-operation', revision: 0, kind: 'expense', amount: 85_000,
    date, accountId: 'cash', categoryId: 'food', description: 'Тестовый обед', status: 'posted',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const state: FinanceState = {
    accounts: [{ id: 'cash', name: 'Наличные', currency: 'RUB', initialBalance: 0, balance: -85_000, archived: false }],
    categories: [{ id: 'food', name: 'Продукты', kind: 'expense' }, { id: 'other-expense', name: 'Прочее', kind: 'expense' }],
    operations: [operation], drafts: [], watchlist: [], summaries: [], deliveries: [], telegram: null,
    capabilities: { text: false, vision: false, telegram: false },
  }
  const patches: (OperationInput & { expectedRevision: number })[] = []
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === '/api/finance/state') return route.fulfill({ json: state })
    if (path === '/api/finance/stats') return route.fulfill({ json: {
      from: date, to: date, income: 0, expense: operation.amount, net: -operation.amount,
      previousIncome: 0, previousExpense: 0, expenseByCategory: [],
    } })
    if (path === `/api/finance/operations/${operation.id}` && request.method() === 'PATCH') {
      const input = request.postDataJSON() as OperationInput & { expectedRevision: number }
      patches.push(input)
      if (input.expectedRevision !== (operation.revision ?? 0)) return route.fulfill({ status: 409, json: {
        error: 'Операция изменена в другом окне. Обновите данные и проверьте актуальные поля перед сохранением.',
      } })
      const { expectedRevision, ...fields } = input
      Object.assign(operation, fields, { revision: expectedRevision + 1 })
      state.accounts[0]!.balance = -operation.amount
      return route.fulfill({ json: operation })
    }
    if (path === '/api/finance/chat/conversations' || path === '/api/finance/payments') return route.fulfill({ json: [] })
    return route.fulfill({ status: 503, json: { error: 'Изолированная браузерная проверка' } })
  })
  const open = async (target: Page) => {
    await target.goto('/')
    await target.getByRole('button', { name: 'Финансы', exact: true }).click()
    await target.getByRole('row').filter({ hasText: 'Тестовый обед' }).getByRole('button', { name: 'Изменить', exact: true }).click()
    await expect(target.locator('form.finance-entry:visible').getByLabel('Сумма, ₽', { exact: true })).toHaveValue('850,00')
  }
  return { operation, state, patches, open }
}

test('two windows cannot overwrite a posted amount; refreshing lets the second window save its category safely', async ({ page, context }) => {
  const f = await fixture(page)
  const second = await context.newPage()
  await f.open(page)
  await f.open(second)
  await page.locator('form.finance-entry:visible').getByLabel('Сумма, ₽', { exact: true }).fill('8500,00')
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(page.getByText('Изменения сохранены. История операции обновлена.', { exact: true })).toBeVisible()
  expect(f.operation.revision).toBe(1)

  const form = second.locator('form.finance-entry:visible')
  await form.getByRole('combobox', { name: 'Категория', exact: true }).selectOption('other-expense')
  await form.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(second.getByRole('alert').filter({ hasText: 'Операция изменена в другом окне.' })).toBeVisible()
  expect(f.patches[1]?.expectedRevision).toBe(0)
  expect(f.operation.amount).toBe(850_000)
  expect(f.operation.categoryId).toBe('food')
  expect(f.state.accounts[0]!.balance).toBe(-850_000)

  await second.getByRole('button', { name: 'Обновить данные', exact: true }).click()
  await expect(form.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeDisabled()
  await expect(form.getByRole('combobox', { name: 'Категория', exact: true })).toHaveValue('other-expense')
  await form.getByRole('button', { name: 'Загрузить актуальные поля', exact: true }).click()
  await expect(form.getByLabel('Сумма, ₽', { exact: true })).toHaveValue('8500,00')
  await form.getByRole('combobox', { name: 'Категория', exact: true }).selectOption('other-expense')
  await form.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(second.getByText('Изменения сохранены. История операции обновлена.', { exact: true })).toBeVisible()
  expect(f.patches[2]?.expectedRevision).toBe(1)
  expect(f.operation.revision).toBe(2)
  expect(f.operation.amount).toBe(850_000)
  expect(f.operation.categoryId).toBe('other-expense')
  expect(f.state.accounts[0]!.balance).toBe(-850_000)
})

test('a legacy posted operation without a revision is editable as version zero', async ({ page }) => {
  const f = await fixture(page)
  delete f.operation.revision
  await f.open(page)
  await page.locator('form.finance-entry:visible').getByRole('combobox', { name: 'Категория', exact: true }).selectOption('other-expense')
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(page.getByText('Изменения сохранены. История операции обновлена.', { exact: true })).toBeVisible()
  expect(f.patches[0]?.expectedRevision).toBe(0)
  expect(f.operation.revision).toBe(1)
  expect(f.operation.amount).toBe(85_000)
})
