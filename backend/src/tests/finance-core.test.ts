import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FinanceService } from '../finance/service.js'
import { MemoryFinanceStore, PostgresFinanceStore } from '../finance/store.js'
import { createApp } from '../app.js'
import { financePort } from '../finance/setup.js'
import { runFinanceAgent } from '../finance/agent.js'
import { FinanceTelegramBot, TelegramClient } from '../finance/telegram.js'
import type { FinanceTelegramPort } from '../finance/telegram.js'

const input={kind:'expense' as const,amount:125050,date:'2026-10-18',accountId:'cash',categoryId:'food',description:'Продукты'}
const now=()=>new Date('2026-10-18T18:01:00Z')
void test('draft has no money effects; concurrent explicit confirmation is idempotent; cancel reverses balance',async()=>{
  const service=new FinanceService(new MemoryFinanceStore())
  const draft=await service.createDraft('alice',input)
  assert.equal((await service.state('alice')).accounts[0]!.balance,0)
  const results=await Promise.all([service.confirmDraft('alice',draft.id),service.confirmDraft('alice',draft.id)])
  assert.equal(results[0]!.id,results[1]!.id)
  assert.equal((await service.state('alice')).operations.length,1)
  assert.equal((await service.state('alice')).accounts[0]!.balance,-125050)
  await assert.rejects(()=>service.confirmDraft('bob',draft.id),/не найден/)
  await service.cancelOperation('alice',results[0]!.id)
  assert.equal((await service.state('alice')).accounts[0]!.balance,0)
  assert.equal((await service.history('alice',results[0]!.id)).length,2)
})
void test('transfers are atomic and excluded from income/expense, period comparisons use equal days',async()=>{
  const service=new FinanceService(new MemoryFinanceStore())
  const card=await service.createAccount('alice',{name:'Карта',initialBalance:200000})
  const transfer=await service.createDraft('alice',{kind:'transfer',amount:10000,date:input.date,accountId:card.id,destinationAccountId:'cash'})
  await service.confirmDraft('alice',transfer.id)
  const state=await service.state('alice')
  assert.equal(state.accounts.find(item=>item.id===card.id)!.balance,190000)
  assert.equal(state.accounts.find(item=>item.id==='cash')!.balance,10000)
  assert.equal((await service.stats('alice',input.date,input.date)).expense,0)
  const previous=await service.createDraft('alice',{...input,date:'2026-10-17',amount:5000});await service.confirmDraft('alice',previous.id)
  const draft=await service.createDraft('alice',input);const operation=await service.confirmDraft('alice',draft.id)
  await service.updateOperation('alice',operation.id,{...input,amount:8000})
  const stats=await service.stats('alice',input.date,input.date)
  assert.equal(stats.expense,8000);assert.equal(stats.previousExpense,5000)
  assert.equal(stats.expenseByCategory[0]!.amount,8000)
  await assert.rejects(()=>service.createDraft('alice',{...input,amount:1.1}))
  await assert.rejects(()=>service.createDraft('alice',{...input,date:'2026-02-30'}))
  await assert.rejects(()=>service.stats('alice','2026-10-19','2026-10-18'))
})
void test('missing and archived references block confirmation; duplicate/receipt discrepancies are visible',async()=>{
  const service=new FinanceService(new MemoryFinanceStore())
  const incomplete=await service.createDraft('alice',{description:'Нет суммы'})
  assert.ok(incomplete.missing.includes('Сумма'));await assert.rejects(()=>service.confirmDraft('alice',incomplete.id),/Заполните/)
  const first=await service.createDraft('alice',input);await service.confirmDraft('alice',first.id)
  const repeated=await service.createDraft('alice',{...input,items:[{name:'Товар',quantity:1,total:1}]})
  assert.ok(repeated.warnings.some(w=>w.includes('дубликат')));assert.ok(repeated.warnings.some(w=>w.includes('Сумма позиций')))
  await service.updateAccount('alice','cash',{archived:true})
  await assert.rejects(()=>service.confirmDraft('alice',repeated.id),/Счёт/)
})
void test('receipt routes protect profile, file types and enforce recognition as draft only',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'finance-receipts-'))
  const store=new MemoryFinanceStore()
  const finance=new FinanceService(store,undefined,{text:false,vision:true,async run(){throw new Error('unused')},async recognize(){return {...input,accountId:null,categoryId:null,items:[{name:'Продукты',quantity:1,total:125050}]}}},{receiptDir:directory})
  const app=createApp(undefined,{finance})
  try {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64')
    const uploaded=await app.inject({method:'POST',url:'/api/finance/receipts?profileId=alice',headers:{'content-type':'image/png','x-filename':'receipt.png'},payload:png})
    assert.equal(uploaded.statusCode,200)
    const id=uploaded.json().id
    assert.equal((await app.inject({method:'GET',url:`/api/finance/receipts/${id}/image?profileId=bob`})).statusCode,404)
    const recognized=await app.inject({method:'POST',url:`/api/finance/receipts/${id}/recognize?profileId=alice`})
    assert.equal(recognized.statusCode,200);assert.equal(recognized.json().status,'pending')
    assert.equal((await finance.state('alice')).operations.length,0)
    assert.equal((await app.inject({method:'POST',url:'/api/finance/receipts',headers:{'content-type':'image/png'},payload:Buffer.from('fake')})).statusCode,400)
    const duplicate=await finance.uploadReceipt('alice','receipt.png','image/png',png);assert.equal(duplicate.duplicate,true)
    const draft=await finance.updateDraft('alice',recognized.json().id,{accountId:'cash',categoryId:'food'})
    const operation=await finance.confirmDraft('alice',draft.id);assert.equal(operation.receiptId,id)
    await finance.updateOperation('alice',operation.id,{...input,amount:10000});assert.equal((await finance.state('alice')).operations[0]!.receiptId,id)
  } finally {await app.close();await rm(directory,{recursive:true,force:true})}
})
void test('receipt and wardrobe photo routes coexist with independent image size limits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'finance-photo-scopes-'))
  const finance=new FinanceService(new MemoryFinanceStore(),undefined,undefined,{receiptDir:directory})
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64')
  let backgroundCalls=0
  const app=createApp(undefined,{finance,remover:{
    configured:true,
    async start(bytes,type){backgroundCalls++;assert.deepEqual(bytes,png);assert.equal(type,'image/png');return {id:'photo-job',status:'queued'}},
    async status(id){return {id,status:'succeeded'}},
    async result(){return png},
    async cancel(){},
  }})
  try {
    const receipt=await app.inject({method:'POST',url:'/api/finance/receipts?profileId=alice',headers:{'content-type':'image/png'},payload:png})
    assert.equal(receipt.statusCode,200)
    const image=await app.inject(`/api/finance/receipts/${receipt.json().id}/image?profileId=alice`)
    assert.deepEqual(image.rawPayload,png)
    const garment=await app.inject({method:'POST',url:'/api/wardrobe/photos/remove-background',headers:{'content-type':'image/png'},payload:png})
    assert.equal(garment.statusCode,202)
    assert.equal(garment.json().status,'queued')
    const larger=Buffer.concat([png,Buffer.alloc(6*1024*1024+1-png.length)])
    assert.equal((await app.inject({method:'POST',url:'/api/finance/receipts?profileId=alice',headers:{'content-type':'image/png'},payload:larger})).statusCode,200)
    assert.equal((await app.inject({method:'POST',url:'/api/wardrobe/photos/remove-background',headers:{'content-type':'image/png'},payload:larger})).statusCode,413)
    assert.equal(backgroundCalls,1)
    assert.equal((await finance.state('alice')).operations.length,0)
  } finally {await app.close();await rm(directory,{recursive:true,force:true})}
})
void test('link codes are one use/expiring; updates durable dedup and deliveries have bounded retries',async()=>{
  let clock=now()
  const store=new MemoryFinanceStore(),service=new FinanceService(store,undefined,undefined,{telegram:true,now:()=>clock})
  const code=await service.issueLink('alice');assert.equal(await service.consumeLinkCode(code.code,'123','123'),true)
  assert.equal(await service.consumeLinkCode(code.code,'456','456'),false)
  assert.equal(await store.binding('123','123'),'alice');assert.equal(await store.binding('456','123'),null)
  const expired=await service.issueLink('bob');clock=new Date(clock.getTime()+600001)
  assert.equal(await service.consumeLinkCode(expired.code,'456','456'),false)
  assert.equal(await store.claimUpdate(17),true);assert.equal(await store.claimUpdate(17),false)
  let delivery=await service.claimDelivery('alice','2026-10-18',clock.toISOString());assert.ok(delivery)
  assert.equal(await service.claimDelivery('alice','2026-10-18',clock.toISOString()),null)
  await service.finishDelivery('alice',delivery!.id,'failed');clock=new Date(clock.getTime()+61000)
  delivery=await service.claimDelivery('alice','2026-10-18',clock.toISOString());assert.equal(delivery!.attempts,2)
  clock=new Date(clock.getTime()+121000)
  assert.equal(await service.claimDelivery('alice','2026-10-18',clock.toISOString()),null)
  assert.equal((await service.state('alice')).deliveries[0]!.status,'uncertain')
})
void test('actual Telegram photo -> draft correction -> explicit confirmation -> website balance',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'finance-flow-'))
  const store=new MemoryFinanceStore(),service=new FinanceService(store,undefined,{text:false,vision:true,async run(){throw new Error('unused')},async recognize(){return {kind:'expense',amount:35050,date:'2026-10-18',description:'Чек'}}},{receiptDir:directory,telegram:true})
  const code=await service.issueLink('default');await service.consumeLinkCode(code.code,'123','123')
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64')
  const client=new TelegramClient('123:test',{fetch:async(url)=>{
    if(String(url).includes('/getFile'))return Response.json({ok:true,result:{file_path:'photos/test.png',file_size:png.length}})
    if(String(url).includes('/file/'))return new Response(png)
    return Response.json({ok:true,result:true})
  }})
  const port:FinanceTelegramPort={claimUpdate:id=>store.claimUpdate(id),bindingForUser:async(user,chat)=>{const id=await store.binding(user,chat);return id?{profileId:id}:null},consumeLinkCode:(code,user,chat)=>service.consumeLinkCode(code,user,chat),state:id=>service.state(id),createTextDraft:async()=>{throw new Error('unused')},createReceiptDraft:async(id,file)=>{const receipt=await service.uploadReceipt(id,file.filename,file.mime,Buffer.from(file.bytes));return service.recognize(id,receipt.id)},updateDraft:(profile,id,patch)=>service.updateDraft(profile,id,patch),confirmDraft:(profile,id,revision)=>service.confirmDraft(profile,id,revision),cancelDraft:async(profile,id)=>{await service.cancelDraft(profile,id)},setPendingDraft:(profile,id)=>service.setPendingDraft(profile,id),pendingDraft:id=>service.pendingDraft(id),summary:async()=>{throw new Error('unused')},getCursor:()=>store.cursor(),setCursor:async n=>{await store.cursor(n)}}
  const bot=new FinanceTelegramBot(port,client)
  try {
    const message={message_id:1,chat:{id:123,type:'private'},from:{id:123}}
    await bot.handleUpdate({update_id:1,message:{...message,photo:[{file_id:'photo'}]}})
    assert.equal((await service.state('default')).operations.length,0)
    await bot.handleUpdate({update_id:2,message:{...message,text:'счёт Наличные'}})
    await bot.handleUpdate({update_id:3,message:{...message,text:'категория Продукты'}})
    const draft=(await service.state('default')).drafts[0]!
    assert.equal(draft.missing.length,0)
    await bot.handleUpdate({update_id:4,callback_query:{id:'cb',from:{id:123},message,data:`confirm:${draft.id}:${draft.revision ?? 0}`}})
    const state=await service.state('default')
    assert.equal(state.operations.length,1);assert.equal(state.accounts[0]!.balance,-35050)
  } finally {await rm(directory,{recursive:true,force:true})}
})
void test('Postgres migrations, rollback, restart, isolation and concurrent confirmation', {skip:!process.env.FINANCE_TEST_DATABASE_URL},async()=>{
  const url=process.env.FINANCE_TEST_DATABASE_URL!,store=new PostgresFinanceStore(url)
  await store.migrate();await store.migrate()
  const profile=`test_${Date.now()}`,service=new FinanceService(store)
  try {
    const draft=await service.createDraft(profile,input)
    const operations=await Promise.all([service.confirmDraft(profile,draft.id),service.confirmDraft(profile,draft.id)])
    assert.equal(operations[0]!.id,operations[1]!.id)
    await assert.rejects(()=>store.transact(profile,data=>{data.accounts=[];throw new Error('rollback')}))
    assert.equal((await service.state(profile)).accounts.length,1)
    const second=new PostgresFinanceStore(url)
    try {
      const another = new FinanceService(second)
      assert.equal((await another.state(profile)).operations.length,1)
      assert.equal((await another.state(`${profile}_other`)).operations.length,0)
      const editable = await service.createDraft(profile,input)
      const saves = await Promise.allSettled([
        service.updateDraft(profile,editable.id,{amount:10000},0),
        another.updateDraft(profile,editable.id,{amount:20000},0),
      ])
      assert.equal(saves.filter(item=>item.status==='fulfilled').length,1)
      assert.equal((saves.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.statusCode,409)
      await assert.rejects(()=>another.confirmDraft(profile,editable.id,0),{statusCode:409})
      const current = (await another.state(profile)).drafts.find(item=>item.id===editable.id)!
      assert.equal(current.revision,1)
      const posted = await another.confirmDraft(profile,editable.id,current.revision)
      assert.equal(posted.amount,current.amount)
    } finally {await second.close()}
  } finally {await store.close()}
})
void test('agent tool port reads real deterministic statistics without exposing confirmation',async()=>{
  const finance=new FinanceService(new MemoryFinanceStore())
  const reply=await runFinanceAgent(financePort(finance,'alice'),'Покажи баланс',{planner:{async next(){return {content:'',calls:[{id:'1',name:'finance_accounts',arguments:{}}]}}}})
  assert.match(reply.text,/Наличные/);assert.equal((await finance.state('alice')).operations.length,0)
})
