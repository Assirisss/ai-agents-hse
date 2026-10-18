import type { Account, AgentReply, Category, Draft, DraftField, DraftInput, FieldProvenance, OperationFilter, OperationKind } from '../../../shared/finance.js'
import type { AgentFinancePort } from './tools.js'
import { moscowDate } from './agent.js'
import { formatMoney, sumKopecks } from './money.js'

const fields: Record<string, string> = { kind: 'тип операции', amount: 'сумму', date: 'дату', accountId: 'счёт', destinationAccountId: 'счёт получателя', categoryId: 'категорию' }
const HELP = 'Команды без модели:\n/expense 850 продукты; счёт Наличные; дата сегодня\n/income 10000 зарплата; счёт Карта\n/transfer 500; со счёта Карта; на счёт Наличные\n/accounts — счета\n/categories — категории\n/drafts — черновики\n/balance — остатки\n/expenses — расходы за месяц\n/period прошлый месяц — доходы и расходы\n\nКоманды добавления используют сегодняшнюю дату, если дата не указана. Свободный текст требует уточнения даты и счёта. Запись сохраняется только кнопкой «Подтвердить».'
const reply = (text: string): AgentReply => ({ text, steps: [], method: 'rules' })
const rule = (excerpt: string, note?: string): FieldProvenance => ({ method: 'rule', excerpt, ...(note ? { note } : {}) })
const normalize = (text: string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exists = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date
function shift(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }

/** Decimal strings are converted with integer arithmetic; repeated/multiple sums stay ambiguous. */
function amountIn(text: string): { amount?: number; excerpt?: string; error?: string } {
  const clean = text.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b\d{1,2}:\d{2}\b/g, match => ' '.repeat(match.length))
  const found = [...clean.matchAll(/(?<![\p{L}\p{N}.,])[-−]?(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d+)?(?![\p{L}\p{N}.,])(?:\s*(?:тыс(?:яч[аиу]?)?\.?|коп(?:е[йе]к[аи]?)?\.?|руб(?:л[её]й|ля|ль)?\.?|₽))?/giu)]
  if (found.length > 1) return { error: 'Указано несколько сумм. Добавляйте одну операцию за сообщение и уточните её сумму.' }
  const excerpt = found[0]?.[0]
  if (!excerpt) return {}
  const numeric = excerpt.match(/^[-−]?[\d \u00a0]+(?:[.,]\d+)?/)![0].replace(/[ \u00a0]/g, '')
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(numeric)) return { error: 'Укажите положительную сумму с точностью до копейки, например 850,50.' }
  const [whole, fraction = ''] = numeric.replace(',', '.').split('.')
  let value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (/тыс/iu.test(excerpt)) value *= 1000n
  if (/коп/iu.test(excerpt)) { if (fraction) return { error: 'Количество копеек должно быть целым.' }; value = BigInt(whole!) }
  if (value <= 0n || value > 100_000_000_000_000n) return { error: 'Сумма должна быть положительной и не превышать 1 трлн рублей.' }
  return { amount: Number(value), excerpt }
}

function dateIn(text: string, today: string): { date?: string; excerpt?: string; error?: string } {
  const found: { date: string; excerpt: string }[] = []
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)) found.push({ date: match[1] ? `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1].padStart(2, '0')}` : match[0], excerpt: match[0] })
  for (const match of text.matchAll(/(?:^|[^а-яё])(позавчера|сегодня|вчера|завтра)(?=$|[^а-яё])/giu)) found.push({ date: shift(today, ({ сегодня: 0, вчера: -1, позавчера: -2, завтра: 1 } as Record<string, number>)[normalize(match[1]!)]!), excerpt: match[1]! })
  if (found.some(item => !exists(item.date))) return { error: 'Указана несуществующая дата. Используйте YYYY-MM-DD, ДД.ММ.ГГГГ или «сегодня» / «вчера».' }
  if (new Set(found.map(item => item.date)).size > 1) return { error: 'Указаны разные даты. Уточните одну дату операции.' }
  return found[0] || {}
}

function named<T extends Account | Category>(text: string, items: T[]): { item: T; excerpt: string; index: number }[] {
  const source = normalize(text)
  return items.flatMap(item => {
    const words = normalize(item.name).split(/\s+/)
    const expression = words.map(word => {
      const stem = word.length >= 4 ? word.replace(/(?:ыми|ими|ый|ой|ий|ая|яя|ое|ее|ые|ие|а|я|ь|ы|и)$/u, '') : word
      return `${escape(stem)}[а-яё]*`
    }).join('\\s+')
    const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escape(normalize(item.id))}|${expression})(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(source)
    if (!match) return []
    const index = match.index + match[0].length - match[1]!.length
    return [{ item, excerpt: text.slice(index, index + match[1]!.length), index }]
  })
}

function kindIn(text: string): { kind?: OperationKind; excerpt?: string } {
  const match = /(?:^|[^а-яё])(перевод(?:ы|а)?|перев[её]л|перевела|доход(?:ы|а)?|заработал[аи]?|получил[аи]?|зарплата|расход(?:ы|а)?|потратил[аи]?|заплатил[аи]?|купил[аи]?)(?=$|[^а-яё])/iu.exec(text)
  if (!match) return {}
  return { kind: /^(перев)/iu.test(match[1]!) ? 'transfer' : /^(доход|заработ|получ|зарплат)/iu.test(match[1]!) ? 'income' : 'expense', excerpt: match[1] }
}

function periodIn(text: string, today: string, previous?: OperationFilter): OperationFilter | { error: string } {
  const literal = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(item => item[0])
  if (literal.length) {
    if (literal.length > 2 || literal.some(date => !exists(date)) || literal.length === 2 && literal[0]! > literal[1]!) return { error: 'Укажите корректный период: /period 2026-10-01 2026-10-18.' }
    return { from: literal[0], to: literal[1] || literal[0] }
  }
  const source = normalize(text)
  if (/(?:прошл|предыдущ)[а-я]*\s+месяц/u.test(source)) { const end = shift(`${today.slice(0, 7)}-01`, -1); return { from: `${end.slice(0, 7)}-01`, to: end } }
  if (/(?:эт|текущ)[а-я]*\s+месяц|за\s+месяц/u.test(source)) return { from: `${today.slice(0, 7)}-01`, to: today }
  if (/недел/u.test(source)) {
    const day = new Date(`${today}T12:00:00Z`).getUTCDay() || 7
    const monday = shift(today, 1 - day)
    return /прошл|предыдущ/u.test(source) ? { from: shift(monday, -7), to: shift(monday, -1) } : { from: monday, to: today }
  }
  const day = dateIn(text, today)
  if (day.error) return { error: day.error }
  if (day.date) return { from: day.date, to: day.date }
  if (/за\s+(?:вс[её]|весь)|всего|за\s+вс[её]\s+время/u.test(source)) return { from: '0001-01-01', to: today }
  return { from: previous?.from || `${today.slice(0, 7)}-01`, to: previous?.to || today }
}

function draftReply(draft: Draft, tool: 'finance_create_draft' | 'finance_update_draft'): AgentReply {
  const defaults = draft.provenance?.date?.note
  return { text: `${tool === 'finance_create_draft' ? 'Подготовлен' : 'Обновлён'} черновик.${draft.amount ? ` Сумма: ${formatMoney(draft.amount)}.` : ''}${defaults ? ` ${defaults}` : ''} ${draft.missing.length ? `Уточните ${draft.missing.map(key => fields[key] || key).join(', ')}.` : 'Проверьте поля и подтвердите операцию кнопкой.'} В учёт операция попадёт только после вашего подтверждения.`, draft, steps: [{ tool, status: 'ok' }], method: 'rules' }
}

/** Predictable commands and followups work without a model and never confirm an operation. */
export async function runFinanceCommands(port: AgentFinancePort, raw: string, context: { now: Date; activeDraft?: Draft; filter?: OperationFilter }): Promise<AgentReply | null> {
  const text = raw.trim(), today = moscowDate(context.now)
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/iu.exec(text)
  const name = command?.[1]?.toLowerCase(), args = command?.[2]?.trim() || ''
  if (name === 'help' || name === 'finance' && !args) return reply(HELP)
  if (name === 'finance') return runFinanceCommands(port, args, context)
  if (name === 'accounts') return { ...reply((await port.accounts()).filter(item => !item.archived).map(item => `${item.name}: ${formatMoney(item.balance)}`).join('\n') || 'Счета пока не добавлены. Создайте счёт на сайте.'), steps: [{ tool: 'finance_accounts', status: 'ok' }] }
  if (name === 'categories') return { ...reply((await port.categories()).map(item => `${item.name} — ${item.kind === 'income' ? 'доход' : 'расход'}`).join('\n') || 'Категории пока не добавлены.'), steps: [{ tool: 'finance_categories', status: 'ok' }] }
  if (name === 'drafts') {
    const drafts = await port.drafts?.()
    return reply(drafts ? drafts.filter(item => item.status === 'pending').map(item => `${item.id}: ${item.description || fields[item.kind || ''] || 'операция'}${item.amount ? ` — ${formatMoney(item.amount)}` : ''}`).join('\n') || 'Незавершённых черновиков нет.' : 'Черновики доступны на сайте во вкладке «Черновики и чеки».')
  }
  const accounts = (await port.accounts()).filter(item => !item.archived)
  const accountMatches = named(text, accounts)
  if (name === 'balance' || /(?:^|[^а-яё])(?:баланс|остат(?:ок|ки|ков|ке)|сколько\s+денег)(?:$|[^а-яё])/iu.test(text)) {
    if (accountMatches.length > 1) return reply('Уточните один счёт или используйте /balance для всех счетов.')
    const selected = accountMatches.length ? [accountMatches[0]!.item] : accounts
    return { ...reply(selected.map(item => `${item.name}: ${formatMoney(item.balance)}`).join('\n') || 'Счета пока не добавлены. Создайте счёт на сайте.'), steps: [{ tool: 'finance_accounts', status: 'ok' }] }
  }
  const explicitEntry = name === 'income' || name === 'expense' || name === 'transfer'
  const modifying = /^(?:\/edit\s+)?(?:сумма|дата|сч[её]т|категория|описание|тип|получатель)(?:\s|[:=])/iu.test(text)
  const parsedKind = kindIn(text)
  const shortFollowup = Boolean(context.activeDraft && !parsedKind.kind && !/(?:покажи|сколько|только\s+по|а\s+за|за\s+прошл)/iu.test(text) && (/^(?:с|со|на|в|сегодня|вчера|позавчера|\d{4}-\d{2}-\d{2})(?:\s|[,;])/iu.test(text) && accountMatches.length || /^(?:сегодня|вчера|позавчера|\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d{1,2})?)$/iu.test(text)))
  const statsIntent = !explicitEntry && !modifying && !shortFollowup && (name === 'expenses' || name === 'period' || name === 'operations' || /(?:сколько|статистик|покажи|расходы|доходы|за\s+(?:прошл|эт|текущ)|только\s+по|а\s+за|по\s+категори)/iu.test(text))
  if (statsIntent) {
    const period = periodIn(text, today, context.filter)
    if ('error' in period) return reply(period.error)
    const categories = await port.categories(), matches = named(text, categories)
    if (accountMatches.length > 1 || matches.length > 1) return reply('Уточните один счёт и одну категорию для фильтра.')
    const filter: OperationFilter = { ...context.filter, ...period }
    if (/все\s+счета|всем\s+счетам/iu.test(text)) delete filter.accountId
    if (/все\s+категории|всем\s+категориям/iu.test(text)) delete filter.categoryId
    if (accountMatches[0]) filter.accountId = accountMatches[0].item.id
    if (matches[0]) filter.categoryId = matches[0].item.id
    if (/доход[\s\S]*расход|расход[\s\S]*доход/iu.test(text)) delete filter.kind
    else if (name === 'expenses' || /расход|потрат/iu.test(text)) filter.kind = 'expense'
    else if (/доход|заработ/iu.test(text)) filter.kind = 'income'
    else if (name === 'period') delete filter.kind
    const operations = (await port.operations(filter)).filter(item => item.status === 'posted')
    const income = sumKopecks(operations.filter(item => item.kind === 'income').map(item => item.amount))
    const expense = sumKopecks(operations.filter(item => item.kind === 'expense').map(item => item.amount))
    const label = `За ${filter.from} — ${filter.to}${filter.accountId ? `, счёт «${accounts.find(item => item.id === filter.accountId)?.name || filter.accountId}»` : ''}${filter.categoryId ? `, категория «${categories.find(item => item.id === filter.categoryId)?.name || filter.categoryId}»` : ''}`
    const body = name === 'operations' ? operations.slice(0, 20).map(item => `${item.date}: ${formatMoney(item.amount)} — ${item.description}`).join('\n') || 'Операций нет.' : filter.kind === 'expense' ? `Расходы: ${formatMoney(expense)}.` : filter.kind === 'income' ? `Доходы: ${formatMoney(income)}.` : `Доходы: ${formatMoney(income)}, расходы: ${formatMoney(expense)}, разница: ${formatMoney(sumKopecks([income, -expense]))}.`
    return { text: `${label}.\n${body}\nОснование: ${operations.length} подтверждённых операций. Переводы не входят в доходы и расходы.`, steps: [{ tool: 'finance_operations', status: 'ok' }], filter, evidence: [{ label, filter: { ...filter }, operationIds: operations.map(item => item.id), count: operations.length }], method: 'rules' }
  }
  const isUpdate = Boolean(context.activeDraft && (modifying || shortFollowup || name === 'edit'))
  if (!explicitEntry && !isUpdate && !parsedKind.kind) return command ? reply(HELP) : null
  const inputText = explicitEntry ? args : text.replace(/^\/edit\s+/iu, '')
  const explicitField = isUpdate ? /^(сумма|дата|сч[её]т|категория|описание|тип|получатель)\s*[:=]?\s+([\s\S]+)$/iu.exec(inputText) : null
  if (explicitField) {
    const field = normalize(explicitField[1]!), value = explicitField[2]!.trim()
    const patch: DraftInput = {}, origins: Partial<Record<DraftField, FieldProvenance>> = {}
    if (field === 'описание') { patch.description = value; origins.description = rule(value) }
    else if (field === 'сумма') {
      const parsed = amountIn(value)
      if (parsed.error || parsed.amount == null) return reply(parsed.error || 'Укажите сумму в рублях, например «сумма 850,50».')
      patch.amount = parsed.amount; origins.amount = rule(parsed.excerpt!)
    } else if (field === 'дата') {
      const parsed = dateIn(value, today)
      if (parsed.error || !parsed.date) return reply(parsed.error || 'Укажите дату YYYY-MM-DD, ДД.ММ.ГГГГ или «сегодня» / «вчера».')
      patch.date = parsed.date; origins.date = rule(parsed.excerpt!)
    } else if (field === 'тип') {
      const parsed = kindIn(value)
      if (!parsed.kind) return reply('Укажите тип: доход, расход или перевод.')
      patch.kind = parsed.kind; origins.kind = rule(parsed.excerpt!)
      if (parsed.kind === 'transfer') patch.categoryId = null
      else if (context.activeDraft?.kind !== parsed.kind) { patch.categoryId = null; patch.destinationAccountId = null }
    } else if (field === 'категория') {
      const matches = named(value, (await port.categories()).filter(item => !context.activeDraft?.kind || item.kind === context.activeDraft.kind))
      if (matches.length !== 1) return reply('Уточните одну существующую категорию подходящего типа. Список: /categories.')
      patch.categoryId = matches[0]!.item.id; origins.categoryId = rule(matches[0]!.excerpt)
    } else {
      const matches = named(value, accounts)
      if (matches.length !== 1) return reply('Уточните один существующий счёт. Список: /accounts.')
      const key = field === 'получатель' ? 'destinationAccountId' : 'accountId'
      patch[key] = matches[0]!.item.id; origins[key] = rule(matches[0]!.excerpt)
    }
    patch.provenance = { ...context.activeDraft?.provenance, ...origins }
    return draftReply(await port.updateDraft(context.activeDraft!.id, patch), 'finance_update_draft')
  }
  const amount = amountIn(inputText), date = dateIn(inputText, today)
  if (amount.error || date.error) return reply(amount.error || date.error!)
  const kind = explicitEntry ? name as OperationKind : parsedKind.kind || context.activeDraft?.kind || undefined
  const input: DraftInput = {}, provenance: Partial<Record<DraftField, FieldProvenance>> = {}
  if (explicitEntry || !isUpdate || /^(?:тип)\s/iu.test(inputText)) { if (kind) { input.kind = kind; provenance.kind = rule(explicitEntry ? `/${name}` : parsedKind.excerpt || inputText) } }
  if (amount.amount != null) { input.amount = amount.amount; provenance.amount = rule(amount.excerpt!) }
  if (date.date) { input.date = date.date; provenance.date = rule(date.excerpt!) }
  else if (explicitEntry) { input.date = today; provenance.date = rule(`/${name}`, `Дата ${today} выбрана правилом команды: дата не указана, использовано «сегодня» (Europe/Moscow).`) }
  const categories = await port.categories()
  const categoryMatches = named(inputText, categories.filter(item => !kind || item.kind === kind))
  const matchedAccounts = named(inputText, accounts)
  if (categoryMatches.length > 1) return reply('Указаны разные категории. Уточните одну категорию операции.')
  if (categoryMatches[0] && kind !== 'transfer') { input.categoryId = categoryMatches[0].item.id; provenance.categoryId = rule(categoryMatches[0].excerpt) }
  if (kind === 'transfer') {
    for (const match of matchedAccounts) {
      const before = normalize(inputText.slice(0, match.index))
      const destination = /(?:на|в)\s+(?:счет[а-я]*\s+)?$/u.test(before) || /получатель\s*[:=]?\s*$/u.test(before)
      const key = destination ? 'destinationAccountId' : 'accountId'
      if (input[key] && input[key] !== match.item.id) return reply('Уточните счета перевода: «со счёта Карта; на счёт Наличные».')
      input[key] = match.item.id; provenance[key] = rule(match.excerpt)
    }
    if (input.accountId && input.accountId === input.destinationAccountId) return reply('Для перевода нужны разные счета.')
  } else {
    if (matchedAccounts.length > 1) return reply('Указано несколько счетов. Уточните один счёт операции.')
    if (matchedAccounts[0]) { input.accountId = matchedAccounts[0].item.id; provenance.accountId = rule(matchedAccounts[0].excerpt) }
  }
  if (/^(?:категория|сч[её]т|получатель)\s/iu.test(inputText) && !matchedAccounts.length && !categoryMatches.length) return reply(`Название не найдено. Счета: ${accounts.map(item => item.name).join(', ') || 'нет'}. Категории: ${categories.filter(item => !kind || item.kind === kind).map(item => item.name).join(', ')}.`)
  if (/^получатель\s/iu.test(inputText) && matchedAccounts[0]) { input.destinationAccountId = matchedAccounts[0].item.id; delete input.accountId; provenance.destinationAccountId = rule(matchedAccounts[0].excerpt); delete provenance.accountId }
  if (isUpdate && /^описание\s*[:=]?\s+/iu.test(inputText)) { input.description = inputText.replace(/^описание\s*[:=]?\s+/iu, ''); provenance.description = rule(input.description) }
  if (!isUpdate) { input.description = inputText.slice(0, 500); provenance.description = rule(inputText.slice(0, 500)) }
  if (!Object.keys(input).length) return reply('Уточните поле, например «сумма 850,50», «сегодня», «с карты» или «категория Продукты».')
  input.provenance = { ...(isUpdate ? context.activeDraft?.provenance : {}), ...provenance }
  const draft = isUpdate ? await port.updateDraft(context.activeDraft!.id, input) : await port.createDraft(input, 'text')
  return draftReply(draft, isUpdate ? 'finance_update_draft' : 'finance_create_draft')
}
