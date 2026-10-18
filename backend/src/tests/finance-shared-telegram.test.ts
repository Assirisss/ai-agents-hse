import test from 'node:test'
import assert from 'node:assert/strict'
import { TelegramBot, type TelegramUpdate as SharedUpdate } from '../telegram/bot.js'
import { TelegramService } from '../telegram/service.js'
import { registerSharedFinance } from '../finance/shared-telegram.js'
import { FinanceTelegramBot, TelegramClient, type FinanceTelegramPort, type TelegramUpdate } from '../finance/telegram.js'
import { MemoryFinanceStore } from '../finance/store.js'
import { FinanceService } from '../finance/service.js'

function setup(options:{linked?:boolean;pending?:string|null;planning?:boolean;conversation?:boolean}={}) {
  const finance:TelegramUpdate[]=[],planning:string[]=[]
  const telegram=new TelegramService({get:()=>null,set:()=>undefined})
  telegram.router.command('start','Начать',async c=>{planning.push(`start:${c.args}`)})
  telegram.router.command('today','Сегодня',async()=>{planning.push('today')})
  telegram.router.callback('pl:',async()=>{planning.push('callback')})
  telegram.router.text(async c=>{planning.push(c.text)})
  const port={bindingForUser:async()=>options.linked===false?null:{profileId:'default'},pendingDraft:async()=>options.pending||null,hasConversation:async()=>Boolean(options.conversation)} as FinanceTelegramPort
  const financeBot={handleUpdate:async(update:TelegramUpdate)=>{finance.push(update)}} as FinanceTelegramBot
  registerSharedFinance(telegram,financeBot,port,()=>options.planning??true)
  const transport=new TelegramBot('test',async()=>{throw new Error('Network must not be called')})
  let updateId=0
  const dispatch=(text:string)=>telegram.router.dispatch(transport,{update_id:++updateId,message:{message_id:updateId,chat:{id:42,type:'private'},from:{id:42},text}})
  return {finance,planning,telegram,transport,dispatch}
}
void test('shared bot distinguishes financial and planning one-time links without replacing start',async()=>{
 const s=setup()
 await s.dispatch('/start AbCd1234xyz_')
 await s.dispatch('/start fin_0123456789abcdef01234567')
 await s.dispatch('/start 0123456789abcdef01234567')
 assert.deepEqual(s.planning,['start:AbCd1234xyz_'])
 assert.equal(s.finance.length,2)
 assert.ok(s.telegram.router.commandList().some(c=>c.command==='finance'))
})

void test('financial entry commands are claimed while ordinary planning stays with planning', async()=>{
 const s=setup()
 for(const command of ['/income 500 зарплата','/expense 850 продукты','/transfer 500','/accounts','/categories','/drafts','/period прошлый месяц','/operations']) await s.dispatch(command)
 await s.dispatch('Завтра встреча в 15')
 assert.equal(s.finance.length,8)
 assert.deepEqual(s.planning,['Завтра встреча в 15'])
 const menu=s.telegram.router.commandList().map(item=>item.command)
 for(const command of ['income','expense','transfer','accounts','categories','drafts','period','operations'])assert.ok(menu.includes(command))
})

void test('short account and period followups route only with an active financial conversation',async()=>{
 const s=setup({pending:'draft',conversation:true})
 for(const text of ['с карты','сегодня','а за прошлый месяц?','только по карте'])await s.dispatch(text)
 await s.dispatch('сегодня встреча в 15')
 assert.equal(s.finance.length,4)
 assert.deepEqual(s.planning,['сегодня встреча в 15'])
 const empty=setup()
 await empty.dispatch('а за прошлый месяц?')
 assert.equal(empty.finance.length,0)
})
void test('finance commands, photos and callbacks share polling; planning routes still work',async()=>{
 const s=setup()
 await s.dispatch('/balance')
 await s.dispatch('/finance Потратил сегодня 500 рублей')
 await s.dispatch('/today')
 const updates:SharedUpdate[]=[
  {update_id:10,message:{message_id:10,chat:{id:42,type:'private'},from:{id:42},photo:[{file_id:'photo'}]}},
  {update_id:11,callback_query:{id:'f',from:{id:42},data:'confirm:12345678-1234-1234-1234-123456789012:1',message:{message_id:11,chat:{id:42,type:'private'}}}},
  {update_id:12,callback_query:{id:'p',from:{id:42},data:'pl:ok:draft',message:{message_id:12,chat:{id:42,type:'private'}}}},
 ]
 for(const update of updates)await s.telegram.router.dispatch(s.transport,update)
 assert.equal(s.finance.length,4)
 assert.equal(s.finance[1]!.message!.text,'Потратил сегодня 500 рублей')
 assert.equal(s.finance[1]!.message!.from!.id,42)
 assert.deepEqual(s.planning,['today','callback'])
})
void test('free text and pending edits keep explicit ownership of the conversation',async()=>{
 const s=setup({pending:'draft'})
 await s.dispatch('Завтра встреча в 15')
 await s.dispatch('сумма 350,50')
 await s.dispatch('/cancel')
 assert.deepEqual(s.planning,['Завтра встреча в 15'])
 assert.deepEqual(s.finance.map(u=>u.message!.text),['сумма 350,50','/cancel'])
 const financeOnly=setup({planning:false})
 await financeOnly.dispatch('Продукты сегодня')
 assert.equal(financeOnly.finance.length,1)
 const unlinked=setup({linked:false})
 await unlinked.dispatch('Завтра встреча')
 assert.equal(unlinked.finance.length,0)
 assert.deepEqual(unlinked.planning,['Завтра встреча'])
})

function linkFixture(planningLinked = false) {
 const store=new MemoryFinanceStore()
 let now=new Date('2026-10-18T21:35:00Z'),modelCalls=0,updateId=100
 const finance=new FinanceService(store,undefined,undefined,{telegram:true,now:()=>now})
 const replies:string[]=[],planning:string[]=[]
 const fetcher:typeof fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body)) as {text?:string}
  if(body.text)replies.push(body.text)
  return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{headers:{'Content-Type':'application/json'}})
 }
 const port:FinanceTelegramPort={
  claimUpdate:id=>store.claimUpdate(id),
  bindingForUser:async(user,chat)=>{const profileId=await store.binding(user,chat);return profileId?{profileId}:null},
  consumeLinkCode:(code,user,chat)=>finance.consumeLinkCode(code,user,chat),
  state:id=>finance.state(id),
  createTextDraft:async()=>{throw new Error('Start must never create a draft')},
  chat:async()=>{modelCalls++;throw new Error('Start must never call the agent')},
  createReceiptDraft:async()=>{throw new Error('Unused')},
  updateDraft:(profile,id,input)=>finance.updateDraft(profile,id,input),
  confirmDraft:(profile,id,revision)=>finance.confirmDraft(profile,id,revision),
  cancelDraft:async(profile,id)=>{await finance.cancelDraft(profile,id)},
  setPendingDraft:(profile,id)=>finance.setPendingDraft(profile,id),
  pendingDraft:profile=>finance.pendingDraft(profile),
  summary:async()=>{throw new Error('Unused')},
  getCursor:()=>store.cursor(),setCursor:async offset=>{await store.cursor(offset)},
 }
 const bot=new FinanceTelegramBot(port,new TelegramClient('123:test',{fetch:fetcher}))
 const telegram=new TelegramService({get:()=>null,set:()=>undefined})
 telegram.router.command('start','Начать',async context=>{planning.push(context.args)})
 telegram.router.text(async context=>{planning.push(context.text)})
 registerSharedFinance(telegram,bot,port,()=>planningLinked)
 const transport=new TelegramBot('test',fetcher)
 const dispatch=(text:string,user=42)=>telegram.router.dispatch(transport,{update_id:++updateId,message:{message_id:updateId,chat:{id:user,type:'private'},from:{id:user},text}})
 return {store,finance,replies,planning,dispatch,modelCalls:()=>modelCalls,advance:()=>{now=new Date(now.getTime()+600001)}}
}

void test('real shared link flow acknowledges fresh, repeated and bare starts without calling the model',async()=>{
 const s=linkFixture(),link=await s.finance.issueLink('default')
 await s.dispatch(`/start ${link.code}`)
 assert.equal(await s.store.binding('42','42'),'default')
 assert.match(s.replies.at(-1)!,/^Профиль привязан\./)
 await s.dispatch(`/start ${link.code}`)
 assert.match(s.replies.at(-1)!,/^Финансовый профиль уже привязан\./)
 assert.match(s.replies.at(-1)!,/код не применён/)
 await s.dispatch('/start')
 assert.match(s.replies.at(-1)!,/^Финансовый профиль уже привязан\./)
 assert.deepEqual(s.planning,[])
 assert.equal(s.modelCalls(),0)
 const state=await s.finance.state('default')
 assert.equal(state.operations.length,0)
 assert.equal(state.drafts.length,0)
})

void test('uppercase start with a bot mention links through the shared router rather than the agent',async()=>{
 const s=linkFixture(),link=await s.finance.issueLink('default')
 await s.dispatch(`/START@assistant_hse_project_bot ${link.code}`)
 assert.equal(await s.store.binding('42','42'),'default')
 assert.match(s.replies.at(-1)!,/^Профиль привязан\./)
 assert.equal(s.modelCalls(),0)
 assert.deepEqual(s.planning,[])
})

void test('expired and malformed financial codes stay in finance and clearly request a new code',async()=>{
 const s=linkFixture(),link=await s.finance.issueLink('default')
 s.advance()
 for(const text of [`/start ${link.code}`,'/start fin_bad']) {
  await s.dispatch(text)
  assert.match(s.replies.at(-1)!,/Код привязки недействителен, истёк или уже использован/)
  assert.equal(await s.store.binding('42','42'),null)
 }
 assert.equal(s.modelCalls(),0)
 assert.deepEqual(s.planning,[])
})

void test('financial starts preserve the planning welcome and planning link codes in a shared chat',async()=>{
 const s=linkFixture(true),link=await s.finance.issueLink('default')
 await s.dispatch(`/start ${link.code}`)
 await s.dispatch('/start')
 await s.dispatch('/start planningCode123')
 assert.equal(await s.store.binding('42','42'),'default')
 assert.deepEqual(s.planning,['','planningCode123'])
 assert.equal(s.modelCalls(),0)
})

void test('an already linked chat cannot consume another profile code or report a successful relink',async()=>{
 const s=linkFixture(),first=await s.finance.issueLink('alice')
 await s.dispatch(`/start ${first.code}`)
 const second=await s.finance.issueLink('bob')
 await s.dispatch(`/start ${second.code}`)
 assert.match(s.replies.at(-1)!,/Финансовый профиль уже привязан/)
 assert.match(s.replies.at(-1)!,/код не применён/)
 assert.equal(await s.store.binding('42','42'),'alice')
 await s.dispatch(`/start ${second.code}`,43)
 assert.equal(await s.store.binding('43','43'),'bob')
 assert.equal(s.modelCalls(),0)
})
