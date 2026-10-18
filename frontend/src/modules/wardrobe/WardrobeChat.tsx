import { wardrobeDisplayText } from '../../../../shared/wardrobe-display.mjs'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WardrobeAction, WardrobeAgentCapabilities, WardrobeAgentProgress, WardrobeChatMessage } from '../../../../shared/wardrobe-agent'
import Markdown from 'react-markdown'
import type { Garment, GarmentPhoto, WardrobeRepository } from './types'
import { askStylist, conversationHistory, getStylistCapabilities, persistChat, readAgentSnapshot, readChat, traceLabels } from './agentClient'
import StylistAction from './StylistAction'
import WardrobeIcon from './WardrobeIcon'
import PhotoImage from './PhotoImage'
import { originalPhotoProcessor, PHOTO_ACCEPT } from './photoProcessor'
import type { PendingChatPhoto } from './chatPhotos'
import { createChatAssets, type ChatAssets } from './chatAssets'
import { createChatToolExecutor } from './chatTools'
import './chat.css'

const starters = [
  { icon: 'layers', title: 'Собрать образ', text: 'Предложи повседневный образ из моих вещей и объясни сочетание.' },
  { icon: 'clock', title: 'Носить чаще', text: 'Какие вещи я редко ношу? Предложи с ними новое сочетание.' },
  { icon: 'bag', title: 'Дополнить гардероб', text: 'Чего не хватает моей коллекции? Предложи одну полезную покупку без выдуманных цен.' },
  { icon: 'sparkles', title: 'Посмотреть тренды', text: 'Обратись к агенту трендов и подбери актуальные идеи для моего гардероба по теме исследования.' },
] as const
const isSafeLink = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol) } catch { return false } }

export default function WardrobeChat({ repository, garments, today, onApply, onAddGarment, onOpenGarment }: {
  repository: WardrobeRepository; garments: Garment[]; today: string
  onApply: (action: WardrobeAction, photo?: GarmentPhoto) => Promise<string>
  onAddGarment: (action: WardrobeAction & { kind: 'garment' }, onSaved: (message: string) => void) => void
  onOpenGarment: (garment: Garment) => void
}) {
  const storageKey = `${repository.namespace}:stylist-chat-v1`
  const [messages, setMessages] = useState<WardrobeChatMessage[]>(() => readChat(storageKey))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [photos, setPhotos] = useState<PendingChatPhoto[]>([])
  const [readingPhotos, setReadingPhotos] = useState(false)
  const [assets] = useState(() => createChatAssets(repository.namespace))
  const [progress, setProgress] = useState<WardrobeAgentProgress[]>([])
  const [applying, setApplying] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [capabilities, setCapabilities] = useState<WardrobeAgentCapabilities | null>(null)
  const [retry, setRetry] = useState(0)
  const [confirmClear, setConfirmClear] = useState(false)
  const request = useRef<AbortController | null>(null)
  const applyingRef = useRef(false)
  const transcript = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const selectingPhotos = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    getStylistCapabilities(controller.signal).then(setCapabilities).catch(() => {
      if (!controller.signal.aborted) setError('Не удалось подключиться к стилисту. Проверьте запуск backend и повторите.')
    })
    return () => { controller.abort(); request.current?.abort() }
  }, [retry])
  useEffect(() => {
    let active = true
    persistChat(storageKey, messages).then(() => { if (active) setStorageError(false) }, () => { if (active) setStorageError(true) })
    return () => { active = false }
  }, [messages, storageKey])
  useEffect(() => {
    const area = transcript.current
    if (area) area.scrollTop = area.scrollHeight
  }, [messages.length, busy])

  function resolveAction(messageId: string, actionId: string, status: 'applied' | 'dismissed', message: string) {
    setMessages(current => current.map(item => item.id === messageId ? { ...item, results: { ...item.results, [actionId]: { status, message } } } : item))
  }

  async function apply(messageId: string, action: WardrobeAction) {
    if (applyingRef.current) return
    setActionErrors(current => ({ ...current, [action.id]: '' }))
    if (action.kind === 'garment') {
      onAddGarment(action, message => resolveAction(messageId, action.id, 'applied', message))
      return
    }
    applyingRef.current = true
    setApplying(action.id)
    try { resolveAction(messageId, action.id, 'applied', await onApply(action)) }
    catch (cause) { setActionErrors(current => ({ ...current, [action.id]: cause instanceof Error ? cause.message : 'Не удалось применить предложение.' })) }
    finally { applyingRef.current = false; setApplying(null) }
  }

  async function attach(files: File[]) {
    if (busy || selectingPhotos.current || !files.length) return
    const capacity = 3 - photos.length
    if (capacity < 1) { setError('За одно сообщение можно отправить до трёх фотографий.'); return }
    selectingPhotos.current = true
    setReadingPhotos(true)
    setError(files.length > capacity ? 'Добавлены первые фотографии. За сообщение можно отправить до трёх.' : '')
    const valid: PendingChatPhoto[] = []
    try {
      for (const file of files.slice(0, capacity)) {
        try { valid.push({ id: crypto.randomUUID(), name: file.name, photo: await originalPhotoProcessor.process(file) }) }
        catch (cause) { setError(`${file.name}: ${cause instanceof Error ? cause.message : 'Не удалось прочитать фото.'}`) }
      }
      setPhotos(current => [...current, ...valid].slice(0, 3))
    } finally { selectingPhotos.current = false; setReadingPhotos(false) }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const rawText = input.trim()
    const text = rawText || (photos.length ? 'Посмотри на прикреплённые фотографии.' : '')
    if (!text || request.current || readingPhotos || applyingRef.current || !capabilities?.configured) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setProgress([]); setError(''); setInput('')
    const attached = [...photos]
    const user: WardrobeChatMessage = { id: crypto.randomUUID(), role: 'user', text, attachments: attached.map(photo => ({ id: photo.id, name: photo.name })), createdAt: new Date().toISOString() }
    const previous = messages
    try {
      for (const photo of attached) await assets.put({ ...photo, createdAt: user.createdAt })
      controller.signal.throwIfAborted()
      setMessages(current => [...current, user].slice(-40))
      setPhotos([])
      const references = [...previous.flatMap(message => [...(message.attachments ?? []).map(item => item.id), ...(message.receipts ?? []).flatMap(item => item.imageId ? [item.imageId] : [])]), ...attached.map(item => item.id)].slice(-12)
      const images = (await Promise.all([...new Set(references)].map(id => assets.get(id)))).filter(item => item !== undefined)
      const execute = createChatToolExecutor({ repository, assets, allowedImageIds: images.map(image => image.id), apply: onApply, onResult: result => {
        if (!result.receipt) return
        const receipt = result.receipt
        // Persist the receipt immediately, even if the next model call fails or is cancelled.
        setMessages(current => [...current.map(item => item.id === user.id && result.garment ? { ...item, attachments: item.attachments?.map(attachment => attachment.id === receipt.imageId ? { ...attachment, garmentId: result.garment!.id } : attachment) } : item), { id: crypto.randomUUID(), role: 'assistant' as const, text: receipt.summary, receipts: [receipt], createdAt: new Date().toISOString() }].slice(-40))
      } })
      const snapshot = await readAgentSnapshot(repository)
      const reply = await askStylist({ message: text, turnId: user.id, history: conversationHistory(previous), snapshot, today, allowTrends: true, trendTopic: 'мода и одежда', currentImageIds: attached.map(image => image.id), attachments: images.map(image => ({ id: image.id, name: image.name.slice(0, 120), processing: image.photo.processing })) }, controller.signal, step => {
        if (!controller.signal.aborted) setProgress(current => [...current, step].slice(-30))
      }, execute)
      if (!controller.signal.aborted) setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, text: reply.text, reply, createdAt: new Date().toISOString() }].slice(-40))
    } catch (cause) {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Не удалось получить ответ.'); setInput(current => current || rawText) }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return <div className="wd-stylist">
    <header className="wd-stylist-heading"><div className="wd-stylist-identity"><span className="wd-stylist-avatar"><WardrobeIcon name="sparkles" size={22} /></span><div><h2>Ваш стилист</h2><p>{capabilities?.configured ? 'Знает коллекцию. Помогает сочетать.' : capabilities ? 'Модель пока не подключена' : 'Подключаемся…'}</p></div></div><div className="wd-inline-actions"><button className="wd-text-button" disabled={busy || !!applying || !messages.length} onClick={() => setConfirmClear(true)}>Новый диалог</button></div></header>
    <div className="wd-stylist-context-line"><span><WardrobeIcon name="hanger" size={14} />В коллекции: {garments.length}</span><span>Фото · образы · тренды</span></div>
    {confirmClear ? <div className="wd-inline-confirm" role="alert"><span>Очистить этот диалог? Сохранённые вещи и образы останутся.</span><button className="wd-danger-button" onClick={() => { setMessages([]); setActionErrors({}); setError(''); setConfirmClear(false) }}>Очистить диалог</button><button onClick={() => setConfirmClear(false)}>Отмена</button></div> : null}
    {capabilities && !capabilities.configured ? <div className="wd-stylist-setup" role="status"><strong>Подключите модель стилиста</strong><p>Стилист использует общую модель платформы. После настройки провайдера перезапустите backend.</p><button className="wd-secondary" onClick={() => { setError(''); setRetry(value => value + 1) }}>Проверить подключение</button></div> : null}
    <div className="wd-stylist-transcript" ref={transcript} role="log" aria-label="Диалог со стилистом" aria-live="polite" aria-busy={busy}>
      {!messages.length ? <div className="wd-stylist-welcome"><span className="wd-stylist-welcome-symbol"><WardrobeIcon name="sparkles" size={38} /></span><h3>Что наденем сегодня?</h3><p>Соберём новое сочетание из знакомых вещей.<br />И найдём идеи, которые подходят именно вам.</p><div className="wd-stylist-starters">{starters.map(starter => <button key={starter.title} disabled={busy || !capabilities?.configured} onClick={() => { setInput(starter.text); composer.current?.focus() }}><WardrobeIcon name={starter.icon} size={21} /><span>{starter.title}</span><WardrobeIcon name="arrow" size={15} /></button>)}</div></div> : messages.map(message => <article key={message.id} className={`wd-chat-message is-${message.role}`} aria-label={message.role === 'user' ? 'Вы' : 'Стилист'}><p className="wd-chat-author">{message.role === 'user' ? 'Вы' : 'Стилист'}{message.reply?.status === 'limited' ? <span>Ответ неполный</span> : null}</p>{message.role === 'user' ? <p className="wd-chat-text">{message.text}</p> : <div className="wd-chat-text wd-chat-markdown"><Markdown skipHtml allowedElements={['p', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'h3', 'h4', 'hr', 'br']} unwrapDisallowed urlTransform={url => message.reply?.sources.some(source => source.url === url && isSafeLink(url)) ? url : ''} components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{wardrobeDisplayText(message.text)}</Markdown></div>}
        {message.attachments?.length ? <div className="wd-chat-attachments">{message.attachments.map(attachment => {
          const garment = garments.find(item => item.id === attachment.garmentId)
          return garment ? <button key={attachment.id} className="wd-chat-attachment" onClick={() => onOpenGarment(garment)} aria-label={`Открыть добавленную вещь: ${garment.name}`}><PhotoImage blob={garment.photo.display} alt={garment.name} /><span>{garment.name}<small>В гардеробе · открыть</small></span><WardrobeIcon name="check" size={15} /></button> : <ChatAttachment key={attachment.id} id={attachment.id} assets={assets} />
        })}</div> : null}
        {message.receipts?.map(receipt => receipt.imageId && !receipt.garmentId ? <ChatAttachment key={receipt.id} id={receipt.imageId} assets={assets} /> : receipt.garmentId ? <button key={receipt.id} className="wd-text-button" onClick={() => { const garment = garments.find(item => item.id === receipt.garmentId); if (garment) onOpenGarment(garment) }}>Открыть вещь ↗</button> : null)}
        {message.reply?.actions.length ? <div className="wd-stylist-actions">{message.reply.actions.map(action => <StylistAction key={action.id} action={action} garments={garments} result={message.results?.[action.id]} busy={applying === action.id} disabled={busy || !!applying} error={actionErrors[action.id]} onApply={() => void apply(message.id, action)} onDismiss={() => resolveAction(message.id, action.id, 'dismissed', 'Предложение пропущено.')} />)}</div> : null}
        {message.reply?.sources.length ? <div className="wd-stylist-sources"><h4>Источники агента трендов</h4>{message.reply.sources.filter(source => isSafeLink(source.url)).map((source, index) => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer"><span>{index + 1}</span><div><strong>{source.title}</strong><small>{source.sourceName} · {source.publishedAt ? new Date(source.publishedAt).toLocaleDateString('ru') : 'Дата не установлена'} · {source.read ? 'Страница прочитана' : 'Выдержка или метаданные'}</small></div><span aria-hidden="true">↗</span></a>)}</div> : null}
        {message.reply?.warnings.length ? <details className="wd-stylist-details"><summary>Ограничения ответа</summary>{message.reply.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
        {message.reply?.trace.length ? <details className="wd-stylist-details"><summary>Действия стилиста · {message.reply.trace.length}</summary>{message.reply.metrics ? <p>Время: {(message.reply.metrics.durationMs / 1000).toFixed(1)} с · Обращений к модели: {message.reply.metrics.modelCalls}</p> : null}<ol>{message.reply.trace.map((step, index) => <li key={index} className={step.status === 'error' ? 'is-error' : ''}><span>{traceLabels[step.tool] ?? step.tool}</span><small>{step.summary} · {(step.durationMs / 1000).toFixed(1)} с</small></li>)}</ol></details> : null}
      </article>)}
      {busy ? <div className="wd-stylist-thinking" role="status"><span className="wd-loading-dot" /><div><p>{progress.at(-1)?.phase === 'tool' ? traceLabels[progress.at(-1)!.tool!] ?? 'Выполняет инструмент…' : progress.at(-1)?.phase === 'queued' ? 'Модель запускается или ожидает свободного места…' : progress.at(-1)?.phase === 'running' ? 'Модель готовит ответ…' : 'Стилист обдумывает следующий шаг…'}</p><ul className="wd-stylist-progress">{progress.filter(step => step.phase === 'tool' && step.status !== 'started').slice(-4).map((step, index) => <li key={index}><WardrobeIcon name={step.status === 'ok' ? 'check' : 'close'} size={13} />{traceLabels[step.tool!] ?? step.tool}</li>)}</ul><small>{capabilities?.provider === 'runpod' ? 'При первом запуске ожидание может занять несколько минут.' : 'Ответ появится здесь. Запрос можно остановить.'}</small></div></div> : null}
    </div>
    {error ? <div className="wd-stylist-error" role="alert"><p>{error}</p>{!capabilities ? <button className="wd-text-button" onClick={() => { setError(''); setRetry(value => value + 1) }}>Повторить подключение</button> : null}</div> : null}
    {photos.length ? <div className="wd-stylist-photo-tray" aria-label="Прикреплённые фотографии"><div>{photos.map((photo, index) => <div className="wd-stylist-pending-photo" key={photo.id}><PhotoImage blob={photo.photo.display} alt={`Фото ${index + 1}`} /><button aria-label={`Убрать фото ${index + 1}`} disabled={busy} onClick={() => setPhotos(current => current.filter(item => item.id !== photo.id))}><WardrobeIcon name="close" size={14} /></button></div>)}</div></div> : null}
    <form className="wd-stylist-composer" onSubmit={send} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); void attach([...event.dataTransfer.files]) }}><input ref={photoInput} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={event => { void attach([...event.target.files ?? []]); event.target.value = '' }} /><button type="button" className="wd-stylist-attach" aria-label="Прикрепить фотографии" title="До 3 фото · JPG, PNG, WebP" disabled={busy || readingPhotos || !capabilities?.configured || photos.length >= 3} onClick={() => photoInput.current?.click()}><WardrobeIcon name="upload" size={21} /></button><label className="wd-sr-only" htmlFor="wd-stylist-message">Сообщение стилисту</label><textarea id="wd-stylist-message" ref={composer} value={input} maxLength={3000} rows={2} placeholder="Например: убери фон и добавь эту вещь в гардероб" disabled={busy} onPaste={event => { const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void attach(images) } }} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />{busy ? <button type="button" className="wd-secondary" onClick={() => { request.current?.abort(); setError('Запрос остановлен. Уже добавленные вещи сохранены.') }}>Остановить</button> : <button type="submit" className="wd-primary" disabled={(!input.trim() && !photos.length) || !capabilities?.configured || !!applying || readingPhotos} aria-label="Отправить сообщение"><WardrobeIcon name="arrow" size={20} /></button>}</form>
    {readingPhotos ? <p className="wd-stylist-footnote" role="status">Подготавливаю фотографии…</p> : null}
    <p className="wd-stylist-footnote">Оригиналы хранятся в этом браузере. Для распознавания уменьшенная копия фото передаётся vision-модели; стилист получает сообщения, характеристики и историю носки.</p>
    {storageError ? <p className="wd-view-error" role="status">Не удалось сохранить диалог на устройстве. Сообщения доступны до закрытия страницы.</p> : null}
  </div>
}

function ChatAttachment({ id, assets }: { id: string; assets: ChatAssets }) {
  const [photo, setPhoto] = useState<GarmentPhoto | null>(null)
  useEffect(() => {
    let active = true
    assets.get(id).then(asset => { if (active) setPhoto(asset?.photo ?? null) }).catch(() => undefined)
    return () => { active = false }
  }, [id, assets])
  return photo ? <div className="wd-chat-photo"><PhotoImage blob={photo.display} alt={photo.processing === 'background-removed' ? 'Фотография без фона' : 'Прикреплённая фотография'} /></div> : <span className="wd-chat-attachment is-file"><WardrobeIcon name="upload" size={18} /><span>Фотография недоступна</span></span>
}
