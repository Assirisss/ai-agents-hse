import type { FastifyInstance } from 'fastify'
import { PassThrough } from 'node:stream'
import { FinanceChatService, financeChatRequestSchema } from './chat.js'
import type { PaymentService } from './payments.js'
import type { FinanceChatEvent } from '../../../shared/finance.js'
import { z } from 'zod'
import { draftSchema, operationSchema, FinanceError, moscowToday, profileSchema } from './schema.js'
import type { FinanceService } from './service.js'

export function registerFinanceRoutes(app: FastifyInstance, finance?: FinanceService, financeChat?: FinanceChatService, payments?: PaymentService) {
  app.addContentTypeParser(['image/jpeg','image/png','image/webp'], { parseAs: 'buffer', bodyLimit: 10*1024*1024 }, (_request,body,done)=>done(null,body))
  const profile=(query:unknown)=>z.object({profileId:profileSchema.default('default')}).passthrough().parse(query).profileId
  const params=(raw:unknown)=>z.object({id:z.string().min(1).max(100)}).parse(raw).id
  const expectedRevision = z.number().int().safe().nonnegative()
  const service=()=>{if(!finance) throw new FinanceError('Финансовый модуль не настроен. Укажите DATABASE_URL и запустите Postgres.',503);return finance}

  const chat = () => { if(!financeChat) throw new FinanceError('Финансовый чат не настроен',503);return financeChat }
  const paymentService = () => { if(!payments) throw new FinanceError('Напоминания не настроены',503);return payments }
  const conversationParams = (raw:unknown) => z.object({id:z.string().uuid()}).parse(raw).id
  app.get('/api/finance/chat/conversations', async req => chat().list(profile(req.query)))
  app.post('/api/finance/chat/conversations', async req => { z.object({}).strict().parse(req.body || {});return chat().create(profile(req.query)) })
  app.get('/api/finance/chat/conversations/:id', async req => chat().get(profile(req.query),conversationParams(req.params)))
  app.post('/api/finance/chat/conversations/:id/messages/stream', { bodyLimit:16384 }, async (req,reply) => {
    const input=financeChatRequestSchema.parse(req.body),profileId=profile(req.query),id=conversationParams(req.params),activeChat=chat()
    await activeChat.get(profileId,id)
    const controller=new AbortController(),output=new PassThrough();let completed=false
    output.on('close',()=>{if(!completed)controller.abort()})
    reply.type('application/x-ndjson; charset=utf-8').header('X-Accel-Buffering','no').send(output)
    const send=(event:FinanceChatEvent)=>{if(!output.destroyed&&!controller.signal.aborted)output.write(`${JSON.stringify(event)}\n`)}
    void (async()=>{
      try {const result=await activeChat.send(profileId,id,input,{signal:controller.signal,onProgress:progress=>send({type:'progress',progress})});send({type:'result',result})}
      catch(error){if(!controller.signal.aborted)send({type:'error',error:error instanceof FinanceError?error.message:'Не удалось завершить сообщение. Обновите диалог перед повтором.',conflict:error instanceof FinanceError&&error.statusCode===409})}
      finally{completed=true;if(!output.destroyed)output.end()}
    })()
    return reply
  })
  app.get('/api/finance/payments', async req => { await paymentService().sync(profile(req.query));return paymentService().list(profile(req.query)) })
  app.post('/api/finance/payments', async req => paymentService().create(profile(req.query),req.body))
  app.post('/api/finance/payments/:id/cancel', async req => paymentService().cancel(profile(req.query),params(req.params)))
  app.post('/api/finance/payments/:id/draft', async req => paymentService().draft(profile(req.query),params(req.params)))

  app.get('/api/finance/state',async(req)=>service().state(profile(req.query)))
  app.post('/api/finance/analysis', {bodyLimit:16384}, async(req)=>service().analyze(profile(req.query),req.body))
  app.get('/api/finance/stats',async(req)=>{const args=z.object({from:z.string().default(`${moscowToday().slice(0,7)}-01`),to:z.string().default(moscowToday())}).passthrough().parse(req.query);return service().stats(profile(req.query),args.from,args.to)})
  app.get('/api/finance/context',async(req)=>service().moduleContext(profile(req.query)))
  app.post('/api/finance/accounts',async(req)=>service().createAccount(profile(req.query),req.body))
  app.patch('/api/finance/accounts/:id',async(req)=>service().updateAccount(profile(req.query),params(req.params),req.body))
  app.post('/api/finance/categories',async(req)=>service().createCategory(profile(req.query),req.body))
  app.post('/api/finance/drafts',async(req)=>service().createDraft(profile(req.query),req.body))
  app.patch('/api/finance/drafts/:id',async(req)=>{
    const {expectedRevision: revision, ...input}=draftSchema.extend({expectedRevision}).parse(req.body)
    return service().updateDraft(profile(req.query),params(req.params),input,revision)
  })
  app.post('/api/finance/drafts/:id/confirm',async(req)=>{
    const input=z.object({expectedRevision}).strict().parse(req.body)
    return service().confirmDraft(profile(req.query),params(req.params),input.expectedRevision)
  })
  app.post('/api/finance/drafts/:id/cancel',async(req)=>service().cancelDraft(profile(req.query),params(req.params)))
  app.patch('/api/finance/operations/:id',async(req)=>{
    const {expectedRevision: revision, ...input}=operationSchema.extend({expectedRevision}).parse(req.body)
    return service().updateOperation(profile(req.query),params(req.params),input,revision)
  })
  app.post('/api/finance/operations/:id/cancel',async(req)=>service().cancelOperation(profile(req.query),params(req.params)))
  app.get('/api/finance/operations/:id/audit',async(req)=>service().history(profile(req.query),params(req.params)))
  app.post('/api/finance/agent', {bodyLimit:16384},async(req)=>service().agent(profile(req.query),z.object({text:z.string()}).strict().parse(req.body).text))
  app.post('/api/finance/receipts',{bodyLimit:10*1024*1024},async(req)=>{
    if(!Buffer.isBuffer(req.body)) throw new FinanceError('Отправьте изображение с Content-Type image/jpeg, image/png или image/webp')
    let filename='receipt';try{filename=decodeURIComponent(String(req.headers['x-filename']||'receipt'))}catch{throw new FinanceError('Некорректное имя файла')}
    return service().uploadReceipt(profile(req.query),filename,String(req.headers['content-type']||'').split(';')[0]!,req.body)
  })
  app.get('/api/finance/receipts/:id/image',async(req,reply)=>{const {receipt,bytes}=await service().receiptImage(profile(req.query),params(req.params));return reply.header('X-Content-Type-Options','nosniff').type(receipt.mime).send(bytes)})
  app.post('/api/finance/receipts/:id/recognize',async(req)=>service().recognize(profile(req.query),params(req.params)))
  app.get('/api/finance/instruments',async(req)=>service().instruments(z.object({query:z.string().max(100).default('')}).passthrough().parse(req.query).query))
  app.post('/api/finance/watchlist',async(req)=>service().addInstrument(profile(req.query),z.object({ticker:z.string()}).strict().parse(req.body).ticker))
  app.delete('/api/finance/watchlist/:id',async(req)=>service().removeInstrument(profile(req.query),params(req.params)))
  app.post('/api/finance/summary',async(req)=>service().summary(profile(req.query)))
  app.post('/api/finance/telegram/link',async(req)=>service().issueLink(profile(req.query)))
  app.delete('/api/finance/telegram/link',async(req)=>service().unlink(profile(req.query)))
}
