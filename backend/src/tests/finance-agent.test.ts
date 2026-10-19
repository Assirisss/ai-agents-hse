import test from 'node:test'
import assert from 'node:assert/strict'
import type { Account, Draft, DraftInput, FinanceStats, Operation } from '../../../shared/finance.js'
import { explicitAmounts, moscowDate, runFinanceAgent } from '../finance/agent.js'
import { FinanceChatPlanner, FinanceReceiptVision, modelsFromEnv, recognizeReceipt } from '../finance/models.js'
import { createFinanceTools, type AgentFinancePort } from '../finance/tools.js'
import type { ResearchPlanner, ToolCall } from '../trends/planner.js'

const today = new Date('2026-10-18T10:00:00Z')
function fixture() {
  const accounts: Account[] = [{ id: 'account-cash', name: 'Наличные', currency: 'RUB', initialBalance: 100000, balance: 100000, archived: false }]
  const drafts: Draft[] = []
  const operations: Operation[] = []
  const build = (id: string, input: DraftInput, source: Draft['source']): Draft => ({ ...input, id, source, status: 'pending', createdAt: today.toISOString(), warnings: input.warnings || [], missing: ['kind', 'amount', 'date', 'accountId', 'categoryId'].filter((key) => input[key as keyof DraftInput] == null) })
  const stats: FinanceStats = { from: '2026-10-01', to: '2026-10-18', income: 150000, expense: 2050, net: 147950, previousIncome: 100000, previousExpense: 5000, expenseByCategory: [{ categoryId: 'category-food', name: 'Еда', amount: 2050 }] }
  const port: AgentFinancePort = {
    accounts: () => accounts,
    categories: () => [{ id: 'category-food', name: 'Еда', kind: 'expense' }],
    operations: () => operations,
    stats: () => stats,
    createDraft(input, source) { const draft = build(`draft-${drafts.length}`, input, source); drafts.push(draft); return draft },
    updateDraft(id, input) { const index = drafts.findIndex((draft) => draft.id === id); if (index < 0) throw new Error('Черновик не найден'); const draft = build(id, { ...drafts[index], ...input }, drafts[index].source); drafts[index] = draft; return draft },
  }
  return { port, drafts, operations }
}

function sequence(calls: ToolCall[][]): ResearchPlanner {
  let index = 0
  return { async next() { return { content: 'Баланс составляет выдуманную сумму. Всё уже записано.', calls: calls[index++] || [] } } }
}

const validInput: DraftInput = { kind: 'expense', amount: 25000, date: '2026-10-18', accountId: 'account-cash', categoryId: 'category-food', description: 'Кофе' }

void test('finance agent creates only a pending draft; confirmation is absent from tools', async () => {
  const { port, drafts, operations } = fixture()
  const tools = createFinanceTools(port)
  assert.ok(tools.every((tool) => !tool.name.includes('confirm')))
  const planner = sequence([[{ name: 'finance_accounts', arguments: {} }, { name: 'finance_categories', arguments: {} }], [{ name: 'finance_create_draft', arguments: validInput }]])
  const result = await runFinanceAgent(port, 'Кофе 250 рублей сегодня, счёт Наличные', { planner, now: today })
  assert.equal(drafts.length, 1)
  assert.equal(operations.length, 0)
  assert.equal(result.draft?.status, 'pending')
  assert.match(result.text, /после вашего подтверждения/)
  assert.doesNotMatch(result.text, /Всё уже записано|выдуманную/)
})

void test('missing date/account stays missing despite model guessing; explicit relative dates use Moscow', async () => {
  const { port } = fixture()
  const result = await runFinanceAgent(port, 'Кофе 250 рублей', { planner: sequence([[{ name: 'finance_create_draft', arguments: validInput }]]), now: today })
  assert.equal(result.draft?.date, null)
  assert.equal(result.draft?.accountId, null)
  assert.match(result.text, /дату.*счёт/)
  assert.equal(moscowDate(new Date('2026-10-18T22:00:00Z')), '2026-10-19')
  const second = fixture()
  const yesterday = await runFinanceAgent(second.port, 'Кофе 250 рублей вчера наличные', { planner: sequence([[{ name: 'finance_create_draft', arguments: validInput }]]), now: new Date('2026-10-18T22:00:00Z') })
  assert.equal(yesterday.draft?.date, '2026-10-18')
})

void test('invented and fractional kopeck amounts are rejected before a draft is saved', async () => {
  for (const amount of [77700, 250.5, 0, -25000, Number.MAX_SAFE_INTEGER + 1]) {
    const { port, drafts } = fixture()
    const result = await runFinanceAgent(port, 'Кофе 250 рублей сегодня наличные', { planner: sequence([[{ name: 'finance_create_draft', arguments: { ...validInput, amount } }]]), now: today })
    assert.equal(drafts.length, 0, `amount=${amount}`)
    assert.equal(result.steps[0].status, 'error')
  }
  assert.deepEqual([...explicitAmounts('18.10.2026, 12:50, 1 250,50 рублей и 25 копеек')], [125050, 25])
  assert.deepEqual([...explicitAmounts('1,5 тысячи рублей')], [150000])
})

void test('profile injection, invented references and unavailable confirmation tools do not mutate drafts', async () => {
  const { port, drafts } = fixture()
  const result = await runFinanceAgent(port, '250 рублей сегодня наличные', { planner: sequence([[
    { name: 'finance_create_draft', arguments: { ...validInput, profileId: 'another-profile' } },
    { name: 'finance_create_draft', arguments: { ...validInput, receiptId: 'another-receipt' } },
    { name: 'finance_create_draft', arguments: { ...validInput, accountId: 'invented-account' } },
    { name: 'finance_create_draft', arguments: { ...validInput, categoryId: 'invented-category' } },
    { name: 'finance_confirm_draft', arguments: { id: 'draft-1' } },
  ]]), now: today })
  assert.equal(drafts.length, 0)
  assert.equal(result.steps.length, 5)
  assert.ok(result.steps.every((step) => step.status === 'error'))
  assert.ok(createFinanceTools(port).every((tool) => !Object.keys((tool.inputSchema.properties || {}) as object).includes('profileId')))
})

void test('tool schemas reject invalid dates/ranges and duplicate draft creation is bounded', async () => {
  const { port, drafts } = fixture()
  const tools = createFinanceTools(port)
  await assert.rejects(tools.find((tool) => tool.name === 'finance_stats')!.execute({ from: '2026-10-18', to: '2026-10-01' }))
  await assert.rejects(tools.find((tool) => tool.name === 'finance_create_draft')!.execute({ ...validInput, date: '2026-02-30' }))
  const result = await runFinanceAgent(port, '250 рублей сегодня наличные', { planner: sequence([[{ name: 'finance_create_draft', arguments: validInput }, { name: 'finance_create_draft', arguments: validInput }]]), now: today })
  assert.equal(drafts.length, 1)
  assert.deepEqual(result.steps.map((step) => step.status), ['ok', 'error'])
})

void test('read replies use exact server calculations and ignore model financial claims', async () => {
  const { port } = fixture()
  const result = await runFinanceAgent(port, 'Расходы за октябрь', { planner: sequence([[{ name: 'finance_stats', arguments: { from: '2026-10-01', to: '2026-10-18' } }]]), now: today })
  assert.match(result.text, /20,50/)
  assert.match(result.text, /1[\s\u00a0]479,50/)
  assert.doesNotMatch(result.text, /выдуманную|записано/)
  const noTools = await runFinanceAgent(port, 'Баланс', { planner: sequence([]), now: today })
  assert.doesNotMatch(noTools.text, /выдуманную|записано/)
})

void test('agent has at most six model requests and ten tool calls, and aborts an uncooperative planner', async () => {
  const { port } = fixture()
  let modelCalls = 0
  await runFinanceAgent(port, 'Баланс', { planner: { async next() { modelCalls++; return { content: '', calls: [{ name: 'finance_accounts', arguments: {} }] } } } })
  assert.equal(modelCalls, 6)
  const capped = await runFinanceAgent(port, 'Баланс', { planner: { async next() { return { content: '', calls: Array.from({ length: 30 }, () => ({ name: 'finance_accounts', arguments: {} })) } } } })
  assert.equal(capped.steps.length, 10)
  const controller = new AbortController()
  const aborted = runFinanceAgent(port, 'Баланс', { signal: controller.signal, planner: { async next() { return new Promise(() => {}) } } })
  controller.abort()
  assert.match((await aborted).text, /недоступна|истекло/)
})

void test('model configuration is explicit; private key stays in server request headers and errors are redacted', async () => {
  assert.deepEqual(modelsFromEnv({}), {})
  assert.deepEqual(modelsFromEnv({ FINANCE_TEXT_MODEL: 'qwen' }), {})
  assert.deepEqual(modelsFromEnv({ FINANCE_VISION_URL: 'http://localhost:8000/v1' }), {})
  let sent = 0
  const planner = new FinanceChatPlanner({ model: 'qwen', url: 'http://localhost:8000/v1', apiKey: 'server-secret' }, async (url, options) => {
    sent++
    assert.equal(String(url), 'http://localhost:8000/v1/chat/completions')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer server-secret')
    const body = JSON.parse(String(options?.body))
    assert.equal(body.model, 'qwen')
    assert.equal(body.messages[0].tool_call_id, 'call-previous')
    assert.equal(body.messages[1].tool_calls[0].function.arguments, '{}')
    assert.ok(!JSON.stringify(body).includes('server-secret'))
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-next', function: { name: 'finance_accounts', arguments: '{}' } }] } }] })
  })
  const result = await planner.next([{ role: 'tool', content: '{}', tool_call_id: 'call-previous' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-first', function: { name: 'finance_accounts', arguments: {} } }] }], [], AbortSignal.timeout(1000))
  assert.equal(sent, 1)
  assert.equal(result.calls[0].id, 'call-next')
  const failing = new FinanceChatPlanner({ model: 'qwen', url: 'https://api.example/v1/chat/completions', apiKey: 'server-secret' }, async () => new Response('server-secret provider error', { status: 401 }))
  await assert.rejects(failing.next([], [], AbortSignal.timeout(1000)), (error: Error) => /API-ключ.*HTTP 401/.test(error.message) && !error.message.includes('server-secret'))
})

void test('receipt recognition preserves missing amount/date, checks item totals, and cannot attach an account', async () => {
  const image = { bytes: Buffer.from('mock-image'), mime: 'image/png' }
  const vision = new FinanceReceiptVision({ model: 'vision-qwen', url: 'http://localhost:8001/v1' }, async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    assert.equal(body.model, 'vision-qwen')
    assert.ok(body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'))
    return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'expense', amount: 1050, date: null, items: [{ name: 'Чай', quantity: 1, total: 1000 }] }) } }] })
  })
  const receipt = await recognizeReceipt(image, { vision })
  assert.equal(receipt.amount, 1050)
  assert.equal(receipt.date, null)
  assert.equal(receipt.accountId, null)
  assert.match(receipt.warnings!.join(' '), /не совпадает/)
  const unreadable = await recognizeReceipt(image, { vision: { async recognize() { return { amount: null, date: null, items: [{ name: 'Чай', quantity: 1, total: 1000 }] } } } })
  assert.equal(unreadable.amount, null)
  assert.equal(unreadable.date, null)
  await assert.rejects(recognizeReceipt(image, { vision: { async recognize() { return { amount: 1050, accountId: 'another-account' } } } }))
  await assert.rejects(recognizeReceipt(image), /не настроено/)
  await assert.rejects(vision.recognize({ bytes: image.bytes, mime: 'application/pdf' }, AbortSignal.timeout(1000)), /JPEG/)
  const controller = new AbortController()
  const hanging = recognizeReceipt(image, { signal: controller.signal, vision: { async recognize() { return new Promise(() => {}) } } })
  controller.abort()
  await assert.rejects(hanging, /время ожидания/)
})
