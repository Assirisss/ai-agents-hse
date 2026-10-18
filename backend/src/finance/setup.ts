import type { PlanningService } from '../planning/service.js'
import { FinanceChatService } from './chat.js'
import { PaymentService } from './payments.js'
import { financePort } from './ports.js'
export { financePort } from './ports.js'
import { runFinanceAgent } from './agent.js'
import { modelsFromEnv, recognizeReceipt } from './models.js'
import { PostgresFinanceStore } from './store.js'
import { FinanceService } from './service.js'
import { MarketService } from './market.js'
import { FinanceTelegramBot, TelegramClient, type FinanceTelegramPort } from './telegram.js'
import { FinanceWorker } from './worker.js'
import { FinanceError } from './schema.js'

export async function setupFinance(env: NodeJS.ProcessEnv = process.env, planning?: PlanningService) {
  if(!env.DATABASE_URL?.trim()) return undefined
  const store=new PostgresFinanceStore(env.DATABASE_URL)
  try { await store.migrate() } catch(error) {await store.close();throw error}
  const models=modelsFromEnv(env)
  const token=env.TELEGRAM_BOT_TOKEN?.trim()
  const finance:FinanceService=new FinanceService(store,new MarketService(),{
    text:Boolean(models.planner),vision:Boolean(models.vision),
    run:(profileId,text)=>runFinanceAgent(financePort(finance,profileId),text,{planner:models.planner}),
    recognize:(bytes,mime)=>recognizeReceipt({bytes,mime},{vision:models.vision}),
  },{receiptDir:env.FINANCE_RECEIPT_DIR,telegram:Boolean(token),botUsername:env.TELEGRAM_BOT_USERNAME?.replace(/^@/,'')})
  const chat = new FinanceChatService(finance, models.planner)
  finance.chatRunner = (profileId,text) => chat.telegram(profileId,text,`legacy:${crypto.randomUUID()}`)
  const telegramPort:FinanceTelegramPort={
    claimUpdate:(id)=>store.claimUpdate(id),bindingForUser:async(userId,chatId)=>{const profileId=await store.binding(userId,chatId);return profileId?{profileId}:null},
    consumeLinkCode:(code,userId,chatId)=>finance.consumeLinkCode(code,userId,chatId),state:(profileId)=>finance.state(profileId),
    chat:(profileId,text,turnId)=>chat.telegram(profileId,text,turnId),
    hasConversation:async(profileId)=>Boolean((await store.read(profileId)).telegramConversationId),
    createTextDraft:async(profileId,text)=>{const reply=await finance.agent(profileId,text);if(!reply.draft) throw new FinanceError(reply.text);return reply.draft},
    createReceiptDraft:async(profileId,file)=>{const receipt=await finance.uploadReceipt(profileId,file.filename,file.mime,Buffer.from(file.bytes));return finance.recognize(profileId,receipt.id)},
    updateDraft:(profileId,id,patch)=>finance.updateDraft(profileId,id,patch),confirmDraft:(profileId,id,revision)=>finance.confirmDraft(profileId,id,revision),
    cancelDraft:async(profileId,id)=>{await finance.cancelDraft(profileId,id)},setPendingDraft:(profileId,id)=>finance.setPendingDraft(profileId,id),pendingDraft:(profileId)=>finance.pendingDraft(profileId),
    summary:(profileId)=>finance.summary(profileId),getCursor:()=>store.cursor(),setCursor:async(next)=>{await store.cursor(next)},
  }
  let bot:FinanceTelegramBot|undefined,worker:FinanceWorker|undefined
  if(token) {
    const client=new TelegramClient(token)
    bot=new FinanceTelegramBot(telegramPort,client)
    worker=new FinanceWorker({profiles:()=>finance.deliveryProfiles(),claimDelivery:(profileId,date,now)=>finance.claimDelivery(profileId,date,now),summary:(profileId)=>finance.summary(profileId),finishDelivery:(profileId,id,status,error)=>finance.finishDelivery(profileId,id,status,error)},(chatId,text)=>client.sendText(chatId,text),{onError:(message)=>console.error(message)})
  }
  const payments = new PaymentService(store, finance, planning, { send: token ? (chatId,text) => bot!.client.sendText(chatId,text) : undefined, onError: message => console.error(message) })
  return {finance,store,bot,worker,telegramPort,chat,payments}
}
