import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentReply, Draft, DraftInput, FinanceChatResult, FinanceConversation, FinanceConversationSummary, FinanceSnapshot, OperationFilter } from '../../../shared/finance.js'
import type { ResearchPlanner } from '../trends/planner.js'
import { FinanceError, profileSchema } from './schema.js'
import { FinanceService } from './service.js'
import { MemoryFinanceStore } from './store.js'
import { financePort } from './ports.js'
import { runFinanceCommands } from './commands.js'
import { runFinanceAgent } from './agent.js'

export const financeChatRequestSchema = z.object({ turnId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), text: z.string().trim().min(1).max(4000) }).strict()
type Runtime = { activeDraftId?: string; signal?: AbortSignal; onProgress?: (value: { message: string }) => void }

/** Model/tool work runs on a private snapshot. Only a completed turn is committed to Postgres. */
export class FinanceChatService {
  private pending = new Set<string>()
  constructor(private finance: FinanceService, private planner?: ResearchPlanner, private clock = () => new Date()) {}
  async list(profileId: string): Promise<FinanceConversationSummary[]> {
    const data = await this.finance.store.read(profileSchema.parse(profileId))
    return data.conversations.map(({ id, title, revision, updatedAt }) => ({ id, title, revision, updatedAt })).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,40)
  }
  async create(profileId: string): Promise<FinanceConversation> {
    const now = this.clock().toISOString()
    const conversation: FinanceConversation = { id: randomUUID(), title: 'Новый диалог', revision: 0, createdAt: now, updatedAt: now, messages: [], activeDraftId: null, filter: {} }
    await this.finance.store.transact(profileSchema.parse(profileId), data => { data.conversations.push(conversation) })
    return conversation
  }
  async get(profileId: string,id: string) { const data = await this.finance.store.read(profileSchema.parse(profileId)); return this.find(data,id) }
  private find(data: FinanceSnapshot,id:string) { const value=data.conversations.find(item=>item.id===id); if(!value) throw new FinanceError('Диалог не найден в этом профиле',404); return value }
  private progress(runtime: Runtime, message: string) { try { runtime.onProgress?.({message}) } catch { /* UI cannot change a turn. */ } }
  async send(profileId: string,id: string,raw: unknown,runtime:Runtime={}):Promise<FinanceChatResult> {
    profileSchema.parse(profileId)
    const request=financeChatRequestSchema.parse(raw)
    const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex'),turnKey=`${id}:${request.turnId}`
    const data=await this.finance.store.read(profileId),original=this.find(data,id)
    const existing=data.turns.find(turn=>turn.id===turnKey)
    if(existing) {if(existing.fingerprint!==fingerprint)throw new FinanceError('Идентификатор сообщения уже использован с другим содержимым',409);return {conversation:original,messageId:existing.messageId,replayed:true}}
    if(original.revision!==request.expectedRevision)throw new FinanceError('Диалог изменился. Обновите его перед отправкой.',409)
    if(original.messages.length>=200)throw new FinanceError('Достигнут лимит диалога. Создайте новый.',409)
    const pendingKey=`${profileId}:${id}`
    if(this.pending.has(pendingKey))throw new FinanceError('Предыдущее сообщение ещё обрабатывается',409)
    if(this.pending.size>=3)throw new FinanceError('Сейчас обрабатываются три сообщения. Повторите позже.',429)
    const signal=AbortSignal.any([AbortSignal.timeout(65000),...(runtime.signal?[runtime.signal]:[])])
    signal.throwIfAborted();this.pending.add(pendingKey)
    try {
      this.progress(runtime,'Читаем контекст диалога и подтверждённые операции')
      const stagedStore=new MemoryFinanceStore()
      await stagedStore.transact(profileId,value=>Object.assign(value,structuredClone(data)))
      const staged=new FinanceService(stagedStore,undefined,undefined,{now:this.clock})
      const port=financePort(staged,profileId)
      let evidenceFilter:OperationFilter|undefined
      const readOperations=port.operations,readStats=port.stats
      port.operations=async filter=>{evidenceFilter=filter;return readOperations(filter)}
      port.stats=async range=>{evidenceFilter=range;return readStats(range)}
      const activeDraft=data.drafts.find(item=>item.id===(runtime.activeDraftId || original.activeDraftId) && item.status==='pending')
      this.progress(runtime,'Проверяем, можно ли выполнить запрос обычными инструментами')
      let reply=await runFinanceCommands(port,request.text,{now:this.clock(),activeDraft,filter:original.filter})
      signal.throwIfAborted()
      if(!reply) {
        this.progress(runtime,'Агент выбирает инструменты для сложного запроса')
        const update=port.updateDraft
        port.updateDraft=(draftId,input)=>update(draftId,{...input,provenance:this.modelProvenance(input)})
        reply=await runFinanceAgent(port,request.text,{planner:this.planner,signal,now:this.clock(),history:original.messages.map(message=>({role:message.role,text:message.text})),activeDraft,filter:original.filter})
        reply.method ||= 'model'
        if(evidenceFilter && !reply.evidence?.length) {
          const operations=await readOperations(evidenceFilter)
          reply.evidence=[{label:'Операции, использованные для ответа',filter:evidenceFilter,operationIds:operations.map(item=>item.id),count:operations.length}]
        }
      }
      signal.throwIfAborted()
      const working=await stagedStore.read(profileId)
      const changed=working.drafts.filter(draft=>JSON.stringify(draft)!==JSON.stringify(data.drafts.find(old=>old.id===draft.id)))
      this.progress(runtime,'Сохраняем готовый ответ и черновик; финансовая операция требует отдельного подтверждения')
      const response=reply
      return await this.finance.store.transact(profileId,current=>{
        signal.throwIfAborted()
        const repeated=current.turns.find(turn=>turn.id===turnKey)
        if(repeated) {if(repeated.fingerprint!==fingerprint)throw new FinanceError('Идентификатор сообщения уже использован',409);return {conversation:this.find(current,id),messageId:repeated.messageId,replayed:true}}
        const conversation=this.find(current,id)
        if(conversation.revision!==request.expectedRevision)throw new FinanceError('Диалог изменился. Обновите его.',409)
        for(const draft of changed) {
          const initial=data.drafts.find(item=>item.id===draft.id),index=current.drafts.findIndex(item=>item.id===draft.id)
          if(initial && JSON.stringify(current.drafts[index])!==JSON.stringify(initial))throw new FinanceError('Черновик изменился на сайте или в другом сообщении. Обновите диалог.',409)
          if(index<0)current.drafts.push(draft);else current.drafts[index]=draft
        }
        const oldAudit=new Set(data.audit.map(entry=>entry.id));current.audit.push(...working.audit.filter(entry=>!oldAudit.has(entry.id)))
        const now=this.clock().toISOString(),messageId=randomUUID()
        conversation.messages.push({id:randomUUID(),turnId:request.turnId,role:'user',text:request.text,createdAt:now},{id:messageId,turnId:request.turnId,role:'assistant',text:response.text,createdAt:now,reply:response})
        conversation.revision++;conversation.updatedAt=now
        if(conversation.revision===1)conversation.title=request.text.slice(0,65)
        if(response.draft)conversation.activeDraftId=response.draft.id
        else if(activeDraft && !working.drafts.some(item=>item.id===activeDraft.id && item.status==='pending'))conversation.activeDraftId=null
        if(response.filter)conversation.filter=response.filter
        current.turns.push({id:turnKey,conversationId:id,fingerprint,messageId})
        return {conversation,messageId,replayed:false}
      },signal)
    } finally {this.pending.delete(pendingKey)}
  }
  private modelProvenance(input:DraftInput):Draft['provenance'] {
    const result:NonNullable<Draft['provenance']>={}
    for(const key of ['kind','amount','date','accountId','destinationAccountId','categoryId','description'] as const)if(input[key]!==undefined&&input[key]!==null)result[key]={method:'model',note:'Предложено моделью — проверьте'}
    return result
  }
  async telegram(profileId:string,text:string,turnId:string):Promise<AgentReply> {
    let data=await this.finance.store.read(profileSchema.parse(profileId))
    const hash=createHash('sha256').update(turnId).digest('hex')
    const uuid=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
    const saved=data.turns.find(turn=>turn.id.endsWith(`:${uuid}`))
    if(saved) {
      const message=data.conversations.find(item=>item.id===saved.conversationId)?.messages.find(item=>item.id===saved.messageId)
      if(message?.reply)return message.reply
    }
    let id=data.telegramConversationId
    const selected=data.conversations.find(item=>item.id===id)
    if(!selected || selected.messages.length>=200) {
      const created=await this.create(profileId)
      id=await this.finance.store.transact(profileId,current=>{
        const active=current.conversations.find(item=>item.id===current.telegramConversationId)
        if(!active || active.messages.length>=200)current.telegramConversationId=created.id
        return current.telegramConversationId!
      })
      data=await this.finance.store.read(profileId)
    }
    const conversation=this.find(data,id!)
    const result=await this.send(profileId,id!,{turnId:uuid,expectedRevision:conversation.revision,text},{activeDraftId:data.telegramPendingDraftId || undefined})
    return result.conversation.messages.find(message=>message.id===result.messageId)!.reply!
  }
}
