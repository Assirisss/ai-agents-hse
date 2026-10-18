import { useRef, useState, type FormEvent } from 'react'
import type { FinanceState, Receipt } from '../../../../shared/finance'
import EntryEditor from './EntryEditor'
import DraftProvenance from './DraftProvenance'
import { confirmDraft, createDraft, financeRequest, financeUrl, recognizeReceipt, saveDraft, uploadReceipt } from './api'
import { money } from './money'
import type { FinanceAction } from './types'

export default function Drafts({ data, busy, run }: { data: FinanceState; busy: boolean; run: FinanceAction }) {
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [uploaded, setUploaded] = useState<Receipt | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const drafts = data.drafts.filter((item) => item.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  function recognize(id: string) {
    return run('Распознаём чек', async (signal) => { await recognizeReceipt(id, signal); if (!signal.aborted) setUploaded(null) }, 'Чек распознан в черновик. Проверьте каждое поле перед подтверждением.')
  }

  function upload(event: FormEvent) {
    event.preventDefault()
    setFileError('')
    if (!file) { setFileError('Выберите изображение чека.'); return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setFileError('Поддерживаются JPEG, PNG и WebP.'); return }
    if (file.size > 10 * 1024 * 1024) { setFileError('Изображение должно быть не больше 10 МБ.'); return }
    void run('Загружаем чек', async (signal) => {
      const receipt = await uploadReceipt(file, signal)
      if (!signal.aborted) {
        setUploaded(receipt)
        setFile(null)
        if (fileInput.current) fileInput.current.value = ''
      }
    }, 'Изображение загружено. Запустите распознавание или заполните черновик вручную.')
  }

  return <>
    <section className="finance-panel"><h2>Добавить чек</h2><p className="finance-caption">JPEG, PNG или WebP до 10 МБ. Изображение хранится на вашем backend. Распознавание использует настроенную сервером модель.</p><form className="finance-upload" onSubmit={upload}><label>Фото чека<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setFileError('') }} /></label><button className="finance-button finance-primary" type="submit" disabled={busy || !file}>Загрузить изображение</button></form>{fileError ? <p className="finance-error" role="alert">{fileError}</p> : null}
      {uploaded ? <div className="finance-receipt-review"><a href={financeUrl(`/receipts/${encodeURIComponent(uploaded.id)}/image`)} target="_blank" rel="noopener noreferrer"><img className="finance-receipt-image" src={financeUrl(`/receipts/${encodeURIComponent(uploaded.id)}/image`)} alt={`Загруженный чек: ${uploaded.filename}`} /></a><div><h3>{uploaded.filename}</h3>{uploaded.duplicate ? <p className="finance-warning">Такое изображение уже загружалось. Проверьте, нет ли операции по этому чеку.</p> : null}<p className="finance-caption">{data.capabilities.vision ? 'Распознавание подготовит черновик, который можно исправить.' : 'Модель распознавания изображений не настроена. Можно заполнить операцию вручную.'}</p><div className="finance-actions">{data.capabilities.vision ? <button className="finance-button finance-primary" disabled={busy} onClick={() => { void recognize(uploaded.id) }}>Распознать чек</button> : null}<button className="finance-button" disabled={busy} onClick={() => { void run('Создаём черновик', async (signal) => { await createDraft({ receiptId: uploaded.id, warnings: uploaded.duplicate ? ['Это изображение уже загружалось. Проверьте дубликат.'] : [] }, signal); if (!signal.aborted) setUploaded(null) }, 'Черновик с изображением создан. Заполните недостающие поля.') }}>Заполнить вручную</button></div></div></div> : null}
    </section>
    <div className="finance-section-heading"><h2>На проверке · {drafts.length}</h2><span className="finance-caption">Без подтверждения в расчёты не попадают</span></div>
    {drafts.length ? drafts.map((draft) => <section className="finance-panel" key={draft.id}><div className="finance-section-heading"><h3>{draft.description || 'Черновик операции'}</h3><span className="finance-badge">{draft.source === 'receipt' ? 'Из чека' : draft.source === 'text' ? 'Из сообщения' : 'Ручной ввод'}</span></div>{draft.missing.length ? <p className="finance-caption">Требует уточнения: {draft.missing.map((field) => missingLabel(field)).join(', ')}.</p> : null}{draft.warnings.map((warning, index) => <p className="finance-warning" key={`${index}-${warning}`}>{warning}</p>)}{draft.receiptId ? <details className="finance-receipt-details"><summary>Оригинал чека{draft.items?.length ? ` и позиции (${draft.items.length})` : ''}</summary><a href={financeUrl(`/receipts/${encodeURIComponent(draft.receiptId)}/image`)} target="_blank" rel="noopener noreferrer"><img className="finance-receipt-image" src={financeUrl(`/receipts/${encodeURIComponent(draft.receiptId)}/image`)} alt="Оригинал чека к черновику" loading="lazy" /></a>{draft.items?.length ? <ul className="finance-receipt-items">{draft.items.map((item, index) => <li key={index}><span>{item.name}{item.quantity !== null ? ` × ${item.quantity}` : ''}</span><strong>{item.total !== null ? money(item.total) : 'Не распознано'}</strong></li>)}</ul> : null}</details> : null}<DraftProvenance draft={draft} /><EntryEditor mode="draft" initial={draft} accounts={data.accounts} categories={data.categories} disabled={busy} onSave={(input, confirm) => { void run(confirm ? 'Подтверждаем запись' : 'Сохраняем черновик', async (signal) => { if (confirm) await confirmDraft(draft.id, draft.revision ?? 0, signal); else await saveDraft(draft.id, input, draft.revision ?? 0, signal) }, confirm ? 'Операция записана. Остатки и статистика обновлены.' : 'Поля черновика сохранены.') }} onCancel={() => { void run('Отменяем черновик', (signal) => financeRequest(`/drafts/${encodeURIComponent(draft.id)}/cancel`, signal, 'POST'), 'Черновик отменён.') }} /></section>) : <div className="finance-empty"><h3>Черновиков пока нет</h3><p>Добавьте операцию вручную, напишите помощнику или загрузите чек. Все результаты распознавания появятся здесь для проверки.</p></div>}
  </>
}

function missingLabel(field: string) {
  const labels: Record<string, string> = { kind: 'тип', amount: 'сумма', date: 'дата', accountId: 'счёт', destinationAccountId: 'счёт зачисления', categoryId: 'категория' }
  return labels[field] || field
}
