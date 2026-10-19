import { expect, test, type Page } from '@playwright/test'
import type { Draft, FinanceState } from '../../shared/finance.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=', 'base64')

async function fixture(page: Page) {
  const requests: { path: string; profile: string | null; method: string }[] = []
  const states = Object.fromEntries(['default', 'demo'].map(profile => [profile, {
    accounts: [{ id: 'cash', name: profile === 'demo' ? 'Демонстрационные наличные' : 'Личные наличные', currency: 'RUB', initialBalance: 0, balance: 0, archived: false }],
    categories: [{ id: 'food', name: 'Продукты', kind: 'expense' }], operations: [], drafts: [], watchlist: [], summaries: [], deliveries: [], telegram: null,
    capabilities: { text: false, vision: true, telegram: false },
  }])) as Record<string, FinanceState>
  let failRecognition = true
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), profile = url.searchParams.get('profileId')
    requests.push({ path: url.pathname, profile, method: request.method() })
    const state = states[profile || 'default']!
    if (url.pathname === '/api/finance/state') return route.fulfill({ json: state })
    if (url.pathname === '/api/finance/stats') return route.fulfill({ json: { from: '2026-10-01', to: '2026-10-19', income: 0, expense: 0, net: 0, previousIncome: 0, previousExpense: 0, expenseByCategory: [] } })
    if (url.pathname === '/api/finance/receipts') return route.fulfill({ json: { id: 'receipt-demo', filename: 'receipt-demo.png', mime: 'image/png', hash: 'test', duplicate: false, createdAt: '2026-10-19T10:00:00Z' } })
    if (url.pathname.endsWith('/recognize')) {
      if (failRecognition) { failRecognition = false; return route.fulfill({ status: 502, json: { error: 'Превышен лимит запросов к модели. Повторите попытку позже. (HTTP 429)' } }) }
      const draft: Draft = { id: 'receipt-draft', receiptId: 'receipt-demo', kind: 'expense', amount: 125050, date: '2026-10-19', description: 'Демомаркет', items: [{ name: 'Кофе', quantity: 1, total: 125050 }], source: 'receipt', status: 'pending', revision: 0, createdAt: '2026-10-19T10:00:00Z', missing: ['Счёт', 'Категория'], warnings: ['Результат распознавания нужно проверить перед подтверждением.'] }
      state.drafts.push(draft)
      return route.fulfill({ json: draft })
    }
    if (url.pathname.endsWith('/image')) return route.fulfill({ contentType: 'image/png', body: png })
    if (url.pathname === '/api/finance/chat/conversations' || url.pathname === '/api/finance/payments') return route.fulfill({ json: [] })
    return route.fulfill({ status: 503, json: { error: 'Изолированная браузерная проверка' } })
  })
  return { requests, states }
}

test('demo switch isolates finance, receipt and calendar requests and survives a reload', async ({ page }) => {
  const { requests } = await fixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Финансы', exact: true }).click()
  await expect(page.getByText('Личные наличные', { exact: true }).first()).toBeVisible()
  const marker = requests.length
  await page.getByRole('combobox', { name: 'Профиль финансов', exact: true }).selectOption('demo')
  await expect(page).toHaveURL(/financeProfile=demo/)
  await expect(page.getByRole('combobox', { name: 'Профиль финансов', exact: true })).toHaveValue('demo')
  await expect(page.getByText('Демонстрационные наличные', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Личные наличные', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Профиль финансов', exact: true })).toHaveValue('demo')
  await page.getByRole('button', { name: 'Дела и календарь', exact: true }).click()
  await expect.poll(() => requests.filter(item => item.path.startsWith('/api/planning/')).length).toBeGreaterThan(0)
  expect(requests.slice(marker).filter(item => /^\/api\/(finance|planning)\//.test(item.path)).every(item => item.profile === 'demo')).toBe(true)
  await page.getByRole('button', { name: 'Финансы', exact: true }).click()
  await page.getByRole('combobox', { name: 'Профиль финансов', exact: true }).selectOption('default')
  await expect(page).toHaveURL(/financeProfile=default/)
  await expect(page.getByText('Личные наличные', { exact: true }).first()).toBeVisible()
})

test('vision limit keeps uploaded demo image available for retry and recognition never writes money', async ({ page }) => {
  const { requests, states } = await fixture(page)
  await page.goto('/?financeProfile=demo')
  await page.getByRole('button', { name: 'Черновики и чеки', exact: true }).click()
  await page.getByLabel('Фото чека', { exact: true }).setInputFiles({ name: 'receipt-demo.png', mimeType: 'image/png', buffer: png })
  await page.getByRole('button', { name: 'Загрузить изображение', exact: true }).click()
  const recognize = page.getByRole('button', { name: 'Распознать чек', exact: true })
  await expect(recognize).toBeVisible()
  await recognize.click()
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP 429' })).toBeVisible()
  await expect(recognize).toBeEnabled()
  await recognize.click()
  await expect(page.getByLabel('Сумма, ₽', { exact: true }).filter({ visible: true })).toHaveValue('1250,50')
  expect(requests.filter(item => item.path === '/api/finance/receipts')).toHaveLength(1)
  expect(requests.filter(item => item.path.startsWith('/api/finance/')).every(item => item.profile === 'demo')).toBe(true)
  expect(states.default.drafts).toHaveLength(0)
  expect(states.demo.drafts).toHaveLength(1)
  expect(states.demo.operations).toHaveLength(0)
})

test('receipt recognition keeps waiting beyond the previous 75-second browser deadline', async ({ page }) => {
  await page.clock.install()
  const { states } = await fixture(page)
  let release!: () => void, started!: () => void
  const recognitionStarted = new Promise<void>(resolve => { started = resolve })
  const responseReady = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/finance/receipts/*/recognize*', async route => {
    started()
    await responseReady
    const draft: Draft = { id: 'slow-draft', receiptId: 'receipt-demo', kind: 'expense', amount: 125050, date: '2026-10-19', description: 'Медленное распознавание', source: 'receipt', status: 'pending', revision: 0, createdAt: '2026-10-19T10:00:00Z', missing: ['Счёт', 'Категория'], warnings: [] }
    states.demo.drafts.push(draft)
    await route.fulfill({ json: draft })
  })
  await page.goto('/?financeProfile=demo')
  await page.getByRole('button', { name: 'Черновики и чеки', exact: true }).click()
  await page.getByLabel('Фото чека', { exact: true }).setInputFiles({ name: 'receipt-demo.png', mimeType: 'image/png', buffer: png })
  await page.getByRole('button', { name: 'Загрузить изображение', exact: true }).click()
  const recognize = page.getByRole('button', { name: 'Распознать чек', exact: true })
  await recognize.click()
  await recognitionStarted
  await page.clock.fastForward(80_000)
  await expect(recognize).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('Распознаём чек (ожидание до 3 минут)…', { exact: true })).toBeVisible()
  release()
  await expect(page.getByLabel('Сумма, ₽', { exact: true }).filter({ visible: true })).toHaveValue('1250,50')
  expect(states.demo.drafts).toHaveLength(1)
  expect(states.demo.operations).toHaveLength(0)
})
