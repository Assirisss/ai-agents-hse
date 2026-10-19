import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Account, AuditEntry, Delivery, Draft, DraftInput, DraftField, FieldProvenance, FinanceSnapshot, FinanceState, FinanceStats, Instrument, MarketSummary, Operation, Quote, Receipt } from '../../../shared/finance.js'
import { draftSchema, operationSchema, FinanceError, moscowToday, dateSchema, profileSchema } from './schema.js'
import type { FinanceStore } from './store.js'
import { decimalRubles } from './money.js'

export type FinanceMarket = { search(query: string): Promise<Instrument[]>; summary(watchlist: Instrument[], previousQuotes?: Quote[]): Promise<MarketSummary> }
export type FinanceModels = { text: boolean; vision: boolean; run(profileId: string, text: string): Promise<import('../../../shared/finance.js').AgentReply>; recognize(bytes: Buffer, mime: string): Promise<DraftInput> }
function exactKopecks(value: bigint, context: 'Остаток' | 'Сумма статистики') {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (value > maximum || value < -maximum) throw new FinanceError(`${context} выходит за допустимую точность`)
  return Number(value)
}
export class FinanceService {
  constructor(readonly store: FinanceStore, readonly market?: FinanceMarket, readonly models?: FinanceModels, readonly options: { receiptDir?: string; telegram?: boolean; botUsername?: string; now?: () => Date } = {}) {}
  chatRunner?: (profileId: string, text: string) => Promise<import('../../../shared/finance.js').AgentReply>
  private now() { return this.options.now?.() || new Date() }
  private checkProfile(id: string) { return profileSchema.parse(id) }
  private async transaction<T>(id: string, action: (data: FinanceSnapshot) => T | Promise<T>) { return this.store.transact(this.checkProfile(id), action) }
  private audit(data: FinanceSnapshot, entityId: string, action: string, before: unknown, after: unknown) {
    data.audit.push({ id: randomUUID(), entityId, action, before: structuredClone(before), after: structuredClone(after), createdAt: this.now().toISOString() })
  }
  async state(profileId: string): Promise<FinanceState> {
    const data = await this.store.read(this.checkProfile(profileId))
    const accounts = this.balances(data)
    return { accounts, categories: data.categories, operations: data.operations.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
      drafts: data.drafts.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), watchlist: data.watchlist,
      summaries: data.summaries.sort((a,b) => b.generatedAt.localeCompare(a.generatedAt)).slice(0,30), telegram: data.telegram, deliveries: data.deliveries.sort((a,b) => b.date.localeCompare(a.date)).slice(0,30),
      capabilities: { text: Boolean(this.models?.text), vision: Boolean(this.models?.vision), telegram: Boolean(this.options.telegram) } }
  }
  private balances(data: FinanceSnapshot): Account[] {
    return data.accounts.map((account) => {
      let balance = BigInt(account.initialBalance)
      for (const item of data.operations.filter((item) => item.status === 'posted')) {
        if (item.accountId === account.id) balance += item.kind === 'income' ? BigInt(item.amount) : -BigInt(item.amount)
        if (item.kind === 'transfer' && item.destinationAccountId === account.id) balance += BigInt(item.amount)
      }
      return { ...account, balance: exactKopecks(balance, 'Остаток') }
    })
  }
  async createAccount(profileId: string, raw: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(100), initialBalance: z.number().int().safe().min(-100_000_000_000_000).max(100_000_000_000_000).default(0) }).strict().parse(raw)
    return this.transaction(profileId, (data) => {
      const account: Account = { ...input, id: randomUUID(), currency: 'RUB', balance: input.initialBalance, archived: false }
      data.accounts.push(account); this.audit(data, account.id, 'account.created', null, account); return account
    })
  }
  async updateAccount(profileId: string, id: string, raw: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional() }).strict().parse(raw)
    return this.transaction(profileId, (data) => { const account = data.accounts.find((item) => item.id === id); if (!account) throw new FinanceError('Счёт не найден', 404); const before = { ...account }; Object.assign(account, input); this.audit(data, id, 'account.updated', before, account); return account })
  }
  async createCategory(profileId: string, raw: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['income','expense']) }).strict().parse(raw)
    return this.transaction(profileId, (data) => { const category = { ...input, id: randomUUID() }; data.categories.push(category); return category })
  }
  private missing(data: FinanceSnapshot, input: DraftInput) {
    const missing: string[] = []
    if (!input.kind) missing.push('Тип операции')
    if (!input.amount) missing.push('Сумма')
    if (!input.date) missing.push('Дата')
    if (!data.accounts.some((item) => item.id === input.accountId && !item.archived)) missing.push('Счёт')
    if (input.kind === 'transfer') {
      if (!data.accounts.some((item) => item.id === input.destinationAccountId && !item.archived) || input.accountId === input.destinationAccountId) missing.push('Другой счёт зачисления')
    } else if (input.kind && !data.categories.some((item) => item.id === input.categoryId && item.kind === input.kind)) missing.push('Категория')
    return missing
  }
  private warnings(data: FinanceSnapshot, draft: DraftInput, base: string[] = []) {
    const warnings = [...base.filter((item) => !item.startsWith('Возможный дубликат') && !item.startsWith('Сумма позиций'))]
    if (data.operations.some((item) => item.status === 'posted' && item.amount === draft.amount && item.date === draft.date && item.accountId === draft.accountId && item.kind === draft.kind)) warnings.push('Возможный дубликат: операция с такой суммой, датой и счётом уже существует. Проверьте перед подтверждением.')
    if (draft.items?.length && draft.items.every((item) => item.total !== null) && draft.amount && draft.items.reduce((sum, item) => sum + (item.total || 0), 0) !== draft.amount) warnings.push('Сумма позиций не совпадает с итогом чека. Проверьте скидки и итоговую сумму.')
    return [...new Set(warnings)]
  }
  private fieldProvenance(input: DraftInput, method: FieldProvenance['method']) {
    const result: Partial<Record<DraftField, FieldProvenance>> = {}
    for (const field of ['kind','amount','date','accountId','destinationAccountId','categoryId','description'] as const) {
      if (input[field] !== undefined && input[field] !== null && input[field] !== '') result[field] = input.provenance?.[field] || { method, note: method === 'model' ? 'Предложено моделью — проверьте' : method === 'receipt' ? 'Распознано с изображения — проверьте оригинал' : 'Указано пользователем' }
    }
    return result
  }
  async createDraft(profileId: string, raw: unknown, source: Draft['source'] = 'form'): Promise<Draft> {
    const input = draftSchema.parse(raw)
    return this.transaction(profileId, (data) => {
      if (input.receiptId && !data.receipts.some((item) => item.id === input.receiptId)) throw new FinanceError('Чек не найден',404)
      const draft: Draft = { ...input, description: input.description || '', id: randomUUID(), revision: 0, status: 'pending', source, createdAt: this.now().toISOString(), missing: this.missing(data,input), warnings: this.warnings(data,input,input.warnings) }
      const method = source === 'form' ? 'manual' : source === 'receipt' ? 'receipt' : 'model'
      draft.provenance = this.fieldProvenance(input, method)
      data.drafts.push(draft); this.audit(data, draft.id, 'draft.created', null, draft); return draft
    })
  }
  private checkDraftRevision(draft: Draft, expectedRevision?: number) {
    if (expectedRevision !== undefined && (draft.revision ?? 0) !== z.number().int().safe().nonnegative().parse(expectedRevision)) {
      throw new FinanceError('Черновик изменился. Обновите данные и проверьте поля перед сохранением или подтверждением.', 409)
    }
  }
  async updateDraft(profileId: string, id: string, raw: unknown, expectedRevision?: number) {
    const input = draftSchema.parse(raw)
    return this.transaction(profileId, (data) => {
      const draft = data.drafts.find((item) => item.id === id)
      if (!draft) throw new FinanceError('Черновик не найден',404)
      if (draft.status !== 'pending') throw new FinanceError('Черновик уже обработан',409)
      this.checkDraftRevision(draft, expectedRevision)
      if (input.receiptId && !data.receipts.some((item) => item.id === input.receiptId)) throw new FinanceError('Чек не найден',404)
      const before = structuredClone(draft); Object.assign(draft,input)
      const changed = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'provenance' && JSON.stringify(value) !== JSON.stringify(before[key as keyof Draft]))) as DraftInput
      draft.provenance = { ...before.provenance, ...this.fieldProvenance(changed, 'manual'), ...input.provenance }
      draft.missing = this.missing(data,draft); draft.warnings = this.warnings(data,draft,draft.warnings)
      draft.revision = (before.revision ?? 0) + 1
      this.audit(data,id,'draft.updated',before,draft); return draft
    })
  }
  async confirmDraft(profileId: string, id: string, expectedRevision?: number): Promise<Operation> {
    return this.transaction(profileId, (data) => {
      const draft = data.drafts.find((item) => item.id === id)
      if (!draft) throw new FinanceError('Черновик не найден',404)
      this.checkDraftRevision(draft, expectedRevision)
      if (draft.status === 'confirmed') return data.operations.find((item) => item.id === draft.operationId)!
      if (draft.status !== 'pending') throw new FinanceError('Черновик отменён',409)
      draft.missing = this.missing(data,draft)
      if (draft.missing.length) throw new FinanceError(`Заполните: ${draft.missing.join(', ')}`)
      const input = operationSchema.parse({ kind: draft.kind, amount: draft.amount, date: draft.date, accountId: draft.accountId, destinationAccountId: draft.destinationAccountId, categoryId: draft.categoryId, description: draft.description || '' })
      if (input.kind === 'transfer') input.categoryId = null
      else input.destinationAccountId = null
      const operation: Operation = { ...input, id: randomUUID(), revision: 0, status: 'posted', receiptId: draft.receiptId, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() }
      data.operations.push(operation); this.balances(data)
      draft.status = 'confirmed'; draft.operationId = operation.id
      if (data.telegramPendingDraftId === id) data.telegramPendingDraftId = null
      this.audit(data,operation.id,'operation.confirmed',null,operation); return operation
    })
  }
  async cancelDraft(profileId: string, id: string) {
    return this.transaction(profileId,(data) => { const draft = data.drafts.find((item) => item.id === id); if (!draft) throw new FinanceError('Черновик не найден',404); if (draft.status === 'confirmed') throw new FinanceError('Операция уже подтверждена',409); draft.status='cancelled'; if (data.telegramPendingDraftId===id) data.telegramPendingDraftId=null; return { cancelled: true } })
  }
  async updateOperation(profileId: string, id: string, raw: unknown, expectedRevision: number) {
    const input = operationSchema.parse(raw)
    const revision = z.number().int().safe().nonnegative().parse(expectedRevision)
    return this.transaction(profileId,(data) => {
      const operation = data.operations.find((item) => item.id===id)
      if (!operation) throw new FinanceError('Операция не найдена',404)
      if (operation.status !== 'posted') throw new FinanceError('Операция отменена',409)
      if ((operation.revision ?? 0) !== revision) throw new FinanceError('Операция изменена в другом окне. Обновите данные и проверьте актуальные поля перед сохранением.',409)
      const missing = this.missing(data,input); if (missing.length) throw new FinanceError(`Заполните: ${missing.join(', ')}`)
      const before=structuredClone(operation)
      Object.assign(operation,input,{ categoryId: input.kind==='transfer' ? null : input.categoryId, destinationAccountId: input.kind==='transfer' ? input.destinationAccountId : null, revision: revision + 1, updatedAt: this.now().toISOString() })
      this.balances(data); this.audit(data,id,'operation.updated',before,operation); return operation
    })
  }
  async cancelOperation(profileId: string,id: string) { return this.transaction(profileId,(data) => { const item=data.operations.find((item)=>item.id===id); if(!item) throw new FinanceError('Операция не найдена',404); if(item.status==='posted') { const before={...item}; item.status='cancelled'; this.balances(data); item.updatedAt=this.now().toISOString(); this.audit(data,id,'operation.cancelled',before,item) } return item }) }
  async history(profileId: string,id:string): Promise<AuditEntry[]> { const data=await this.store.read(this.checkProfile(profileId)); return data.audit.filter((item)=>item.entityId===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)) }
  async stats(profileId: string, from: string, to: string): Promise<FinanceStats> {
    dateSchema.parse(from); dateSchema.parse(to); if(from>to) throw new FinanceError('Начало периода позже окончания')
    const day=86400000; const length=(Date.parse(to)-Date.parse(from))/day+1
    if(length>3660) throw new FinanceError('Период не больше 10 лет')
    const previousTo=new Date(Date.parse(from)-day).toISOString().slice(0,10), previousFrom=new Date(Date.parse(from)-length*day).toISOString().slice(0,10)
    const data=await this.store.read(this.checkProfile(profileId)), posted=data.operations.filter((item)=>item.status==='posted' && item.kind!=='transfer')
    const sum=(kind:string,start:string,end:string)=>posted.filter((item)=>item.kind===kind && item.date>=start && item.date<=end).reduce((sum,item)=>sum+BigInt(item.amount),0n)
    const income=sum('income',from,to), expense=sum('expense',from,to)
    const groups=new Map<string|null,bigint>()
    for(const item of posted.filter((item)=>item.kind==='expense' && item.date>=from && item.date<=to)) groups.set(item.categoryId||null,(groups.get(item.categoryId||null)||0n)+BigInt(item.amount))
    const result={from,to,income:exactKopecks(income,'Сумма статистики'),expense:exactKopecks(expense,'Сумма статистики'),net:exactKopecks(income-expense,'Сумма статистики'),previousIncome:exactKopecks(sum('income',previousFrom,previousTo),'Сумма статистики'),previousExpense:exactKopecks(sum('expense',previousFrom,previousTo),'Сумма статистики'),expenseByCategory:[...groups].map(([categoryId,amount])=>({categoryId,amount:exactKopecks(amount,'Сумма статистики'),name:data.categories.find((item)=>item.id===categoryId)?.name||'Без категории'})).sort((a,b)=>b.amount-a.amount)}
    return result
  }
  private receiptPath(profileId:string,id:string) { this.checkProfile(profileId); if(!/^[a-f0-9-]{36}$/.test(id)) throw new FinanceError('Некорректный идентификатор чека'); return join(resolve(this.options.receiptDir||'data/finance-receipts'),profileId,id) }
  async uploadReceipt(profileId:string,filename:string,mime:string,bytes:Buffer):Promise<Receipt> {
    this.checkProfile(profileId)
    const valid=(mime==='image/jpeg' && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) || (mime==='image/png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) || (mime==='image/webp' && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')
    if(!valid || bytes.length>10*1024*1024) throw new FinanceError('Нужен JPEG, PNG или WebP до 10 МБ')
    const hash=createHash('sha256').update(bytes).digest('hex')
    const receipt:Receipt={id:randomUUID(),filename:filename.slice(0,200),mime,hash,createdAt:this.now().toISOString(),duplicate:false}
    const path=this.receiptPath(profileId,receipt.id); await mkdir(join(path,'..'),{recursive:true,mode:0o700}); await writeFile(path,bytes,{mode:0o600,flag:'wx'})
    try { return await this.transaction(profileId,(data)=> { receipt.duplicate=data.receipts.some((item)=>item.hash===hash); data.receipts.push(receipt); return receipt }) }
    catch (error) { await unlink(path).catch(()=>undefined); throw error }
  }
  async receiptImage(profileId:string,id:string) { const data=await this.store.read(this.checkProfile(profileId)), receipt=data.receipts.find((item)=>item.id===id); if(!receipt) throw new FinanceError('Чек не найден',404); return {receipt,bytes:await readFile(this.receiptPath(profileId,id))} }
  async recognize(profileId:string,id:string) {
    if(!this.models?.vision) throw new FinanceError('Модель распознавания чеков не настроена. Можно заполнить черновик вручную.',503)
    const {receipt,bytes}=await this.receiptImage(profileId,id)
    const input=await this.models.recognize(bytes,receipt.mime)
    return this.createDraft(profileId,{...input,kind:'expense',receiptId:id,warnings:[...(input.warnings||[]),...(receipt.duplicate?['Это изображение уже загружалось. Проверьте дубликат.']:[])]},'receipt')
  }
  async agent(profileId:string,text:string) { this.checkProfile(profileId); if(this.chatRunner) return this.chatRunner(profileId,text); if(!this.models?.text) throw new FinanceError('Текстовая модель не настроена. Используйте ручную форму.',503); return this.models.run(profileId,z.string().trim().min(1).max(4000).parse(text)) }
  async instruments(query:string) { if(!this.market) throw new FinanceError('Источник котировок не настроен',503); return this.market.search(z.string().trim().max(100).parse(query)) }
  async addInstrument(profileId:string,ticker:string) {
    if(!/^[A-Z0-9]{1,20}$/.test(ticker)) throw new FinanceError('Некорректный тикер')
    const instruments=await this.instruments(ticker), instrument=instruments.find((item)=>item.ticker===ticker)
    if(!instrument) throw new FinanceError('Бумага не найдена на TQBR',404)
    return this.transaction(profileId,(data)=> { if(data.watchlist.some((item)=>item.ticker===ticker)) return instrument; if(data.watchlist.length>=10) throw new FinanceError('Не больше десяти бумаг'); data.watchlist.push(instrument); return instrument })
  }
  async removeInstrument(profileId:string,ticker:string) { return this.transaction(profileId,(data)=> {data.watchlist=data.watchlist.filter((item)=>item.ticker!==ticker);return {deleted:true}}) }
  async summary(profileId:string) { if(!this.market) throw new FinanceError('Источник котировок не настроен',503); const data=await this.store.read(this.checkProfile(profileId)); const latest=data.summaries.sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt))[0]; const report=await this.market.summary(data.watchlist,latest?.quotes); await this.transaction(profileId,(value)=>{ value.summaries.push(report); value.summaries=value.summaries.sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt)).slice(0,60) }); return report }
  async issueLink(profileId:string) { if(!this.options.telegram) throw new FinanceError('Telegram-бот не настроен',503); this.checkProfile(profileId); const code='fin_'+randomBytes(12).toString('hex'), expiresAt=new Date(this.now().getTime()+600000).toISOString(); await this.store.issueCode(profileId,createHash('sha256').update(code).digest('hex'),expiresAt); return {code,expiresAt,botUsername:this.options.botUsername} }
  async unlink(profileId:string) { return this.transaction(profileId,(data)=>{data.telegram=null;data.telegramPendingDraftId=null;return {deleted:true}}) }
  async consumeLinkCode(code:string,userId:string,chatId:string) { return this.store.consumeCode(createHash('sha256').update(code).digest('hex'),userId,chatId,this.now().toISOString()) }
  async setPendingDraft(profileId:string,id:string|null) { await this.transaction(profileId,(data)=>{ if(id && !data.drafts.some((item)=>item.id===id && item.status==='pending')) throw new FinanceError('Черновик недоступен'); data.telegramPendingDraftId=id }) }
  async pendingDraft(profileId:string) { return (await this.store.read(this.checkProfile(profileId))).telegramPendingDraftId || null }
  async deliveryProfiles() { const profiles=[]; for(const profileId of await this.store.profiles()) {const data=await this.store.read(profileId);if(data.telegram) profiles.push({profileId,chatId:data.telegram.chatId,watchlist:data.watchlist})} return profiles }
  async claimDelivery(profileId:string,date:string,now:string):Promise<Delivery|null> {
    dateSchema.parse(date)
    return this.transaction(profileId,(data)=>{
      let delivery=data.deliveries.find((item)=>item.date===date)
      if(delivery) {
        if(delivery.status==='sending' && Date.parse(now)-Date.parse(delivery.updatedAt)>=120000) {delivery.status='uncertain';delivery.error='Отправка прервалась; автоматический повтор отключён';delivery.updatedAt=now;return null}
        if(delivery.status!=='failed' || delivery.attempts>=3 || Date.parse(now)-Date.parse(delivery.updatedAt)<60000) return null
        delivery.status='sending';delivery.attempts++;delivery.updatedAt=now
      } else { delivery={id:randomUUID(),date,status:'sending',attempts:1,updatedAt:now};data.deliveries.push(delivery) }
      return delivery
    })
  }
  async finishDelivery(profileId:string,id:string,status:'sent'|'failed'|'uncertain',error?:string) { await this.transaction(profileId,(data)=>{const item=data.deliveries.find((item)=>item.id===id);if(item) Object.assign(item,{status,error:error?.slice(0,300)||null,updatedAt:this.now().toISOString()})}) }
  async moduleContext(profileId:string) {const today=moscowToday(this.now()),stats=await this.stats(profileId,`${today.slice(0,7)}-01`,today);return {module:'finance' as const,source:'Подтверждённые операции финансового модуля',facts:[`Доходы с начала месяца: ${decimalRubles(stats.income)} RUB`,`Расходы с начала месяца: ${decimalRubles(stats.expense)} RUB`]} }
}
