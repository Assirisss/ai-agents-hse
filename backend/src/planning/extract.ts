import { z } from 'zod'
import type { DraftMethod } from '../../../shared/planning.js'
import { parseItem, splitRequests, type ParseContext, type ParsedItem } from './dateparse.js'
import type { JsonModel } from './model.js'
import { modelExtractionSchema } from './schema.js'
import { humanDate, localDate, parseDateKey } from './time.js'

export type Extraction = { items: ParsedItem[]; method: DraftMethod; question: string | null; notes: string[] }
/** `force` sends every segment to the model even when rules understood it; dates are still computed by rules. */
export type ExtractOptions = { useAi?: boolean; force?: boolean; signal?: AbortSignal }

/**
 * Text → draft items. Rules run first; the model is called only for a concrete reason
 * (several items in one sentence, vague words, missing date) and only segments the text.
 * Dates are always computed by the deterministic parser from phrases quoted from the message.
 */
export class DraftExtractor {
  constructor(private model?: JsonModel) {}
  get modelInfo() { return this.model ? { provider: this.model.provider, model: this.model.model } : null }

  async extract(text: string, context: ParseContext, { useAi = true, force = false, signal = AbortSignal.timeout(100000) }: ExtractOptions = {}): Promise<Extraction> {
    const segments = splitRequests(text)
    const parsed = segments.map((segment) => { const item = parseItem(segment, context); return { segment, item, reasons: modelReasons(item) } })
    const needed = parsed.filter((entry) => force || entry.reasons.length)
    const notes: string[] = []
    if (!needed.length) return { items: parsed.map((entry) => entry.item), method: 'parser', question: null, notes: ['Разобрано правилами без модели.'] }

    const reasonText = [...new Set(needed.flatMap((entry) => entry.reasons))].join('; ')
    if (!useAi || !this.model) {
      notes.push(reasonText ? `Правилам не хватило данных: ${reasonText}.` : 'Разобрано правилами.', useAi || force ? 'Модель не настроена на сервере — проверьте поля вручную.' : 'Модель выключена для этого запроса.')
      const items = parsed.map((entry) => entry.item)
      return { items, method: 'parser', question: questionFor(items), notes }
    }

    notes.push(force ? `Модель вызвана по запросу пользователя${reasonText ? `; правилам к тому же не хватило данных: ${reasonText}` : ', хотя правила справились бы сами'}.` : `Модель вызвана, потому что ${reasonText}.`)
    const items: ParsedItem[] = []
    let question = ''
    let usedModel = 0
    for (const entry of parsed) {
      if (!force && !entry.reasons.length) { items.push(entry.item); continue }
      try {
        const result = await this.segment(entry.segment, context, signal)
        if (!result.items.length) throw new Error('Модель не нашла дел')
        for (const candidate of result.items) items.push(fromModel(candidate, entry.segment, context, notes))
        if (result.question) question = result.question
        usedModel++
      } catch (error) {
        notes.push(`Модель недоступна или ответ не прошёл проверку (${error instanceof Error ? error.message.slice(0, 120) : 'ошибка'}); оставлен результат правил.`)
        items.push(entry.item)
      }
    }
    const method: DraftMethod = !usedModel ? 'parser' : usedModel === parsed.length ? 'ai' : 'parser+ai'
    // A model question is shown only when something is really unknown, not as a formality.
    const unclear = items.some((item) => item.missing.length) || needed.some((entry) => entry.item.vague.length)
    return { items, method, question: unclear ? question || questionFor(items) : null, notes }
  }

  private async segment(text: string, context: ParseContext, signal: AbortSignal) {
    const today = localDate(context.now, context.timeZone)
    const raw = await this.model!.complete(systemPrompt, JSON.stringify({ today: `${humanDate(today)} ${parseDateKey(today).year}`, message: text }), z.toJSONSchema(modelExtractionSchema, { io: 'input' }) as Record<string, unknown>, signal)
    return modelExtractionSchema.parse(raw)
  }
}

export function modelReasons(item: ParsedItem): string[] {
  const reasons: string[] = []
  if (item.compound) reasons.push('в одной фразе несколько дат или времён')
  if (item.vague.length) reasons.push(`есть расплывчатые слова (${item.vague.join(', ')})`)
  if (item.kind === 'event' && item.missing.length) reasons.push(`для события не хватает: ${item.missing.join(', ')}`)
  if (!item.title) reasons.push('не удалось выделить название')
  else if (item.title.length > 80) reasons.push('фраза слишком длинная для правил')
  return reasons
}

function questionFor(items: ParsedItem[]) {
  const incomplete = items.filter((item) => item.missing.length)
  if (!incomplete.length) return null
  return incomplete.map((item) => `Уточните ${item.missing.join(' и ')} для «${item.title || 'дела'}».`).join(' ')
}

const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е')
const words = (value: string) => normalize(value).match(/[\p{L}\p{N}]+/gu) || []
const stopWords = new Set(['в', 'во', 'на', 'до', 'к', 'ко', 'с', 'со', 'по', 'и', 'а', 'не', 'позднее', 'позже', 'срок', 'дедлайн', 'около', 'примерно', 'часов', 'часа', 'час'])

/** A phrase is accepted only if its words occur in the original message (allowing word endings to differ). */
export function quotedFrom(phrase: string, source: string) {
  const available = words(source)
  return words(phrase).filter((word) => !stopWords.has(word)).every((word) => available.some((candidate) => candidate === word || (word.length >= 4 && candidate.length >= 4 && candidate.slice(0, 4) === word.slice(0, 4))))
}

function fromModel(candidate: z.infer<typeof modelExtractionSchema>['items'][number], source: string, context: ParseContext, notes: string[]): ParsedItem {
  const phrase = (value: string, label: string) => {
    if (!value) return ''
    if (quotedFrom(value, source)) return value
    notes.push(`Модель предложила ${label} «${value}», которого нет в сообщении, — фраза отброшена.`)
    return ''
  }
  const when = phrase(candidate.when, 'время')
  const deadline = phrase(candidate.deadline, 'срок').replace(/^(?:до|к|ко|не\s+позднее|не\s+позже)\s+/iu, '')
  const duration = phrase(candidate.duration, 'длительность')
  const repeat = phrase(candidate.repeat, 'повторение')
  const parts = [when, deadline ? `до ${deadline}` : '', duration ? (/^(на|в течение)\s/iu.test(duration) ? duration : `на ${duration}`) : '', repeat].filter(Boolean).join(' ')
  const parsed = parseItem(`${candidate.kind === 'task' ? 'задача' : 'событие'}: ${parts}`, context)
  const title = candidate.title.replace(/\s+/g, ' ').trim()
  return { ...parsed, title: title ? title[0].toLocaleUpperCase('ru') + title.slice(1) : parseItem(source, context).title, assumptions: ['Разбиение и название предложены моделью', ...parsed.assumptions], compound: false, vague: [] }
}

const systemPrompt = `Ты разбираешь сообщения для личного планировщика на русском языке.
Раздели сообщение на отдельные дела. Для каждого дела верни:
- kind: "event" — встреча или событие в определённый день и время; "task" — дело, которое нужно сделать, возможно к сроку;
- title: короткое название без слов о дате и времени;
- when: ДОСЛОВНАЯ фраза из сообщения о дне и времени («завтра в 15», «в пятницу»), иначе пустая строка;
- deadline: ДОСЛОВНАЯ фраза о сроке («до 25-го», «к пятнице»), иначе пустая строка;
- duration: ДОСЛОВНАЯ фраза о длительности («на два часа»), иначе пустая строка;
- repeat: ДОСЛОВНАЯ фраза о повторении («каждый понедельник»), иначе пустая строка.
Не вычисляй даты и не переводи их в числа: копируй слова из сообщения. Не придумывай дел и фраз, которых нет в сообщении.
Если для встречи непонятен день или время, оставь when пустым и задай один короткий вопрос в question; иначе question — пустая строка.
Пример: «встреча с Олей завтра и созвон с банком в пятницу в 11» →
{"items":[{"kind":"event","title":"Встреча с Олей","when":"завтра","deadline":"","duration":"","repeat":""},{"kind":"event","title":"Созвон с банком","when":"в пятницу в 11","deadline":"","duration":"","repeat":""}],"question":"Во сколько встреча с Олей?"}`
