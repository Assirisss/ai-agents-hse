import type { Draft, DraftField } from '../../../../shared/finance'

const labels: Record<DraftField, string> = { kind: 'Тип', amount: 'Сумма', date: 'Дата', accountId: 'Счёт', destinationAccountId: 'Счёт зачисления', categoryId: 'Категория', description: 'Описание' }
const methods = { manual: 'Ввод пользователя', rule: 'Правило разбора', model: 'Предложение модели', receipt: 'Распознавание чека' }

export default function DraftProvenance({ draft }: { draft: Draft }) {
  const fields = Object.entries(draft.provenance ?? {}) as [DraftField, NonNullable<Draft['provenance']>[DraftField]][]
  if (!fields.length) return null
  return <details className="finance-provenance"><summary>Откуда взялись поля</summary><p className="finance-caption">Это способ заполнения, а не подтверждение правильности. Сверьте значения перед записью.</p><dl>{fields.map(([field, source]) => source ? <div key={field}><dt>{labels[field] || field}</dt><dd><span className="finance-badge">{methods[source.method]}</span>{source.excerpt ? <blockquote>«{source.excerpt}»</blockquote> : null}{source.note ? <p>{source.note}</p> : null}</dd></div> : null)}</dl></details>
}
