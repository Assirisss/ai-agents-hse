import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore, PostgresFinanceStore } from '../finance/store.js'
import { FinanceChatService } from '../finance/chat.js'
import { createApp } from '../app.js'
import type { ResearchPlanner } from '../trends/planner.js'
const clock=()=>new Date('2026-10-18T12:00:00Z')
const request=(text:string,expectedRevision=0)=>({turnId:randomUUID(),expectedRevision,text})
function setup(planner?:ResearchPlanner){const store=new MemoryFinanceStore(),finance=new FinanceService(store,undefined,undefined,{now:clock}),chat=new FinanceChatService(finance,planner,clock);return {store,finance,chat}}
void test('rules work without model, history survives service recreation and exact retry never duplicates drafts',async()=>{
 const {store,finance,chat}=setup(),conversation=await chat.create('alice'),input=request('/expense 850 продукты; счёт Наличные; дата сегодня')
 const first=await chat.send('alice',conversation.id,input)
 assert.equal(first.replayed,false);assert.equal(first.conversation.revision,1)
 assert.equal((await finance.state('alice')).drafts.length,1);assert.equal((await finance.state('alice')).operations.length,0)
 const reply=first.conversation.messages.at(-1)!.reply!
 assert.equal(reply.draft!.amount,85000);assert.equal(reply.draft!.provenance!.amount!.method,'rule')
 const fresh=new FinanceChatService(finance,undefined,clock)
 const replay=await fresh.send('alice',conversation.id,input)
 assert.equal(replay.replayed,true);assert.equal(replay.messageId,first.messageId)
 assert.equal((await finance.state('alice')).drafts.length,1)
 await assert.rejects(()=>fresh.send('alice',conversation.id,{...input,text:'/expense 900'}),/идентификатор|Идентификатор/)
 await assert.rejects(()=>fresh.send('alice',conversation.id,request('/balance',0)),/Диалог изменился/)
 await assert.rejects(()=>fresh.get('bob',conversation.id),/не найден/)
 assert.equal((await store.read('alice')).turns.length,1)
})
void test('follow-up supplies missing fields; retained period/account filters give real operation evidence',async()=>{
 const {finance,chat}=setup(),conversation=await chat.create('alice')
 const first=await chat.send('alice',conversation.id,request('Потратил 850 рублей на продукты'))
 assert.equal(first.conversation.messages.at(-1)!.reply!.draft!.date,undefined)
 const second=await chat.send('alice',conversation.id,request('Сегодня, со счёта Наличные',1))
 const draft=second.conversation.messages.at(-1)!.reply!.draft!
 assert.equal(draft.id,first.conversation.activeDraftId);assert.equal(draft.date,'2026-10-18');assert.equal(draft.accountId,'cash')
 assert.equal((await finance.state('alice')).operations.length,0)
 const operation=await finance.confirmDraft('alice',draft.id)
 const third=await chat.send('alice',conversation.id,request('Расходы за этот месяц',2))
 const report=third.conversation.messages.at(-1)!.reply!
 assert.match(report.text,/850,00/);assert.deepEqual(report.evidence![0]!.operationIds,[operation.id])
 const fourth=await chat.send('alice',conversation.id,request('А за прошлый месяц?',3))
 assert.equal(fourth.conversation.filter.from,'2026-09-01');assert.equal(fourth.conversation.filter.kind,'expense')
 assert.equal(fourth.conversation.messages.at(-1)!.reply!.evidence![0]!.count,0)
})
void test('abort before commit discards staged draft/audit/history without holding a financial lock during model work',async()=>{
 let turn=0,started!:()=>void
 const gate=new Promise<void>(resolve=>{started=resolve})
 const planner:ResearchPlanner={async next(){if(turn++===0)return {content:'',calls:[{name:'finance_create_draft',arguments:{kind:'expense',amount:85000,description:'Сложное описание'}}]};started();return new Promise(()=>{})}}
 const {store,finance,chat}=setup(planner),conversation=await chat.create('alice'),controller=new AbortController()
 const pending=chat.send('alice',conversation.id,request('Подготовь необычный вариант записи на 850 рублей'),{signal:controller.signal})
 await gate
 await finance.createAccount('alice',{name:'Во время работы модели',initialBalance:0})
 assert.equal((await finance.state('alice')).drafts.length,0)
 controller.abort();await assert.rejects(pending)
 const data=await store.read('alice')
 assert.equal(data.drafts.length,0);assert.equal(data.conversations[0]!.messages.length,0)
 assert.equal(data.audit.filter(entry=>entry.action.startsWith('draft')).length,0)
})
void test('concurrent website edit is preserved when model commits a staged draft change',async()=>{
 let turn=0,started!:()=>void,release!:()=>void,draftId=''
 const gate=new Promise<void>(resolve=>{started=resolve}),finished=new Promise<void>(resolve=>{release=resolve})
 const planner:ResearchPlanner={async next(){if(turn++===0)return {content:'',calls:[{name:'finance_update_draft',arguments:{id:draftId,input:{description:'Из модели'}}}]};started();await finished;return {content:'',calls:[]}}}
 const {finance,chat}=setup(planner),conversation=await chat.create('alice')
 const first=await chat.send('alice',conversation.id,request('/expense 850 продукты; счёт Наличные'))
 draftId=first.conversation.activeDraftId!
 const pending=chat.send('alice',conversation.id,request('Сделай более краткое описание',1))
 await gate;await finance.updateDraft('alice',draftId,{description:'Правка пользователя'});release()
 await assert.rejects(pending,/Черновик изменился/)
 assert.equal((await finance.state('alice')).drafts[0]!.description,'Правка пользователя')
 assert.equal((await chat.get('alice',conversation.id)).revision,1)
})
void test('two chat workers use persisted revision to commit exactly one simultaneous turn',async()=>{
 const {finance,chat}=setup(),second=new FinanceChatService(finance,undefined,clock),conversation=await chat.create('alice')
 const results=await Promise.allSettled([chat.send('alice',conversation.id,request('/expense 100 продукты')),second.send('alice',conversation.id,request('/expense 200 продукты'))])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.equal((await finance.state('alice')).drafts.length,1)
 assert.equal((await chat.get('alice',conversation.id)).revision,1)
})
void test('HTTP chat streams progress/results and reports version conflict; no model configuration required',async()=>{
 const {finance,chat}=setup(),app=createApp(undefined,{finance,financeChat:chat})
 try{
  const created=await app.inject({method:'POST',url:'/api/finance/chat/conversations',payload:{}})
  assert.equal(created.statusCode,200)
  const id=created.json().id,input=request('/balance')
  const response=await app.inject({method:'POST',url:`/api/finance/chat/conversations/${id}/messages/stream`,payload:input})
  assert.equal(response.statusCode,200)
  const events=response.body.trim().split('\n').map(line=>JSON.parse(line))
  assert.ok(events.some(event=>event.type==='progress'));assert.equal(events.at(-1).type,'result')
  const repeated=await app.inject({method:'POST',url:`/api/finance/chat/conversations/${id}/messages/stream`,payload:input})
  assert.ok(repeated.body.includes('"replayed":true'))
  const conflict=await app.inject({method:'POST',url:`/api/finance/chat/conversations/${id}/messages/stream`,payload:request('/balance')})
  assert.ok(conflict.body.includes('"conflict":true'))
 }finally{await app.close()}
})
void test('Postgres conversations replay and revision are durable across connections',{skip:!process.env.FINANCE_TEST_DATABASE_URL},async()=>{
 const first=new PostgresFinanceStore(process.env.FINANCE_TEST_DATABASE_URL!),second=new PostgresFinanceStore(process.env.FINANCE_TEST_DATABASE_URL!)
 try{
  await first.migrate();const profile=`chat_${Date.now()}`,finance=new FinanceService(first),chat=new FinanceChatService(finance,undefined,clock),conversation=await chat.create(profile),input=request('/expense 120 продукты')
  const result=await chat.send(profile,conversation.id,input)
  const recreated=new FinanceChatService(new FinanceService(second),undefined,clock),replay=await recreated.send(profile,conversation.id,input)
  assert.equal(replay.messageId,result.messageId);assert.equal(replay.replayed,true)
  assert.equal((await second.read(profile)).drafts.length,1)
  const analysis=await recreated.send(profile,conversation.id,request('Почему выросли расходы?',1))
  assert.ok(analysis.conversation.messages.at(-1)!.reply!.analysis)
  const persisted=await new FinanceChatService(new FinanceService(first),undefined,clock).get(profile,conversation.id)
  assert.deepEqual(persisted.messages.at(-1)!.reply!.analysis,analysis.conversation.messages.at(-1)!.reply!.analysis)
 }finally{await first.close();await second.close()}
})
void test('Telegram rotates a full conversation while retaining replay of older updates',async()=>{
 const {store,finance,chat}=setup()
 const original=await chat.telegram('alice','/expense 100 продукты','telegram-update-1')
 await store.transact('alice',data=>{
  const conversation=data.conversations.find(item=>item.id===data.telegramConversationId)!
  while(conversation.messages.length<200)conversation.messages.push({...conversation.messages[0]!,id:randomUUID()})
 })
 const next=await chat.telegram('alice','/balance','telegram-update-2')
 assert.match(next.text,/Наличные/)
 const replay=await chat.telegram('alice','/expense 100 продукты','telegram-update-1')
 assert.equal(replay.draft!.id,original.draft!.id)
 assert.equal((await finance.state('alice')).drafts.length,1)
 assert.equal((await store.read('alice')).conversations.length,2)
})
