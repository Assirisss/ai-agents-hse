import type { HealthAiFact, HealthAiInput, HealthAiResult, HealthState } from '../../../shared/health.js'
import { healthStats } from '../../../shared/health-math.mjs'
import { progressReplySchema } from './ai-schema.js'

export function progressFacts(state: HealthState, input: Extract<HealthAiInput, { operation: 'explain-progress' }>): HealthAiFact[] {
  const stats = healthStats(state, input.to, input.days, input.exerciseId)
  const meals = stats.days.filter(day => day.nutrition !== null)
  const wellbeing = stats.days.filter(day => day.wellbeing !== null)
  const facts: HealthAiFact[] = [
    { id: 'workouts', label: 'Тренировки за период', value: stats.workoutCount, unit: 'шт.' },
    { id: 'cardio', label: 'Время кардио', value: stats.cardioMinutes, unit: 'мин' },
    { id: 'distance', label: 'Записанное расстояние', value: stats.distanceKm, unit: 'км' },
    { id: 'nutrition-days', label: 'Дни с записями питания', value: meals.length, unit: `из ${input.days}` },
    ...(['calories', 'protein', 'fat', 'carbs'] as const).map(key => ({ id: key, label: `${({ calories: 'Калории', protein: 'Белки', fat: 'Жиры', carbs: 'Углеводы' })[key]} · среднее за дни с записями`, value: meals.length ? Math.round(meals.reduce((sum, day) => sum + day.nutrition![key], 0) / meals.length * 10) / 10 : null, unit: key === 'calories' ? 'ккал' : 'г' })),
    { id: 'wellbeing-days', label: 'Дни с отметками самочувствия', value: wellbeing.length, unit: 'дн.' },
    { id: 'wellbeing-first', label: 'Первая отметка самочувствия', value: wellbeing.at(0)?.wellbeing ?? null, unit: '/ 5' },
    { id: 'wellbeing-last', label: 'Последняя отметка самочувствия', value: wellbeing.at(-1)?.wellbeing ?? null, unit: '/ 5' },
  ]
  for (const [index, point] of stats.exercisePoints.slice(-12).entries()) {
    const fields = point.mode === 'cardio' ? { minutes: point.minutes, distance: point.distanceKm, pace: point.pace } : point.mode === 'bodyweight' ? { sets: point.sets, reps: point.reps } : { weight: point.maxWeight, reps: point.reps, volume: point.volume }
    for (const [key, value] of Object.entries(fields)) facts.push({ id: `exercise-${index}-${key}`, label: `${point.date} · ${{ weighted: 'С отягощением', bodyweight: 'Собственный вес', cardio: 'Кардио' }[point.mode]} · ${({ minutes: 'Время', distance: 'Расстояние', pace: 'Темп', weight: 'Максимальный вес', volume: 'Объём', reps: 'Повторения', sets: 'Подходы' } as Record<string, string>)[key]}`, value, unit: ({ minutes: 'мин', distance: 'км', pace: 'мин/км', weight: 'кг', volume: 'кг × повторения', reps: 'повт.', sets: 'подх.' } as Record<string, string>)[key] })
  }
  return facts
}

type ProgressResult = Extract<HealthAiResult, { operation: 'explain-progress' }>
type Insight = { id: string; factId: string; text: string }
export type ProgressExplanation = Omit<ProgressResult, 'observations'> & { insights: Insight[] }
const number = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)

/** Every possible displayed statement is constructed from this request's diary snapshot. */
export function progressExplanation(state: HealthState, input: Extract<HealthAiInput, { operation: 'explain-progress' }>): ProgressExplanation {
  const facts = progressFacts(state, input)
  const value = (id: string) => facts.find(fact => fact.id === id)!.value!
  const nutritionDays = value('nutrition-days'), wellbeingDays = value('wellbeing-days')
  const empty = value('workouts') === 0 && nutritionDays === 0 && wellbeingDays === 0
  const warnings = ['Дневник отражает внесённые записи. Их отсутствие не означает отсутствие еды, движения или изменения самочувствия.']
  if (nutritionDays > 0 && nutritionDays < input.days) warnings.push('Дневник питания заполнен не за каждый день периода. Средние КБЖУ учитывают только дни с записями и могут не отражать полный рацион.')
  if (input.exerciseId) warnings.push('Темп учитывает только кардио с указанным расстоянием. Для собственного веса нагрузка тела и силовой объём не рассчитываются.')
  const insights: Insight[] = empty
    ? [{ id: 'no-data', factId: 'workouts', text: 'В выбранном периоде нет записей тренировок, питания и самочувствия. Для объяснения прогресса нужны записи дневника.' }]
    : facts.map(fact => {
      const measured = fact.value === null ? null : `${number(fact.value)} ${fact.unit}`
      let text: string
      if (fact.id === 'workouts') text = `В дневнике за период записано тренировок: ${number(fact.value!)}.`
      else if (fact.id === 'cardio') text = `Сумма записанной длительности кардио за период: ${measured}.`
      else if (fact.id === 'distance') text = `Сумма указанного в дневнике расстояния: ${measured}. Записи без расстояния в эту сумму не входят.`
      else if (fact.id === 'nutrition-days') text = `Записи питания есть за ${nutritionDays} из ${input.days} дней. Дни без записей не включаются в средние КБЖУ.`
      else if (['calories', 'protein', 'fat', 'carbs'].includes(fact.id)) text = measured === null
        ? 'В периоде нет записей питания; среднее значение не рассчитано.'
        : `Среднее значение: ${measured}; учтено дней с записями: ${nutritionDays}. Расчёт использует внесённые продукты, без оценки незаписанной еды.`
      else if (fact.id === 'wellbeing-days') text = `Дней с отметками самочувствия в дневнике за период: ${wellbeingDays}.`
      else if (fact.id.startsWith('wellbeing-')) text = measured === null
        ? 'В периоде нет отметок самочувствия; значение неизвестно.'
        : `${fact.label} за период: ${measured}. Это записанная пользователем оценка, а не оценка здоровья.`
      else text = measured === null
        ? `Для показателя «${fact.label}» нет данных. Отсутствие значения не заменяется нулём.`
        : `По выбранному упражнению в дневнике: ${fact.label} — ${measured}.`
      return { id: fact.id, factId: fact.id, text }
    })
  if (!empty && input.exerciseId && !facts.some(fact => fact.id.startsWith('exercise-'))) insights.push({ id: 'exercise-no-data', factId: 'workouts', text: 'За выбранный период нет записей выбранного упражнения. Другие тренировки учитываются в общей статистике.' })
  return {
    operation: 'explain-progress', facts, insights,
    message: empty ? 'За выбранный период пока нет записей. Средние КБЖУ и самочувствие остаются неизвестными.' : 'Выводы основаны на записях выбранного периода. Тренер выбрал акценты; числа и формулировки проверены приложением.',
    questions: [
      ...(nutritionDays === 0 ? ['Есть ли записи питания за этот период, которые вы ещё не внесли?'] : []),
      ...(wellbeingDays === 0 ? ['Хотите дополнить дневник отметками самочувствия за этот период?'] : []),
    ],
    warnings,
  }
}

export function selectProgressInsights(explanation: ProgressExplanation, raw: unknown): ProgressResult {
  const { insightIds } = progressReplySchema.parse(raw)
  if (new Set(insightIds).size !== insightIds.length) throw new Error('Duplicate insight')
  const observations = insightIds.map(id => {
    const insight = explanation.insights.find(item => item.id === id)
    if (!insight) throw new Error('Unknown insight')
    return { factId: insight.factId, text: insight.text }
  })
  const { insights: _insights, ...result } = explanation
  return { ...result, observations }
}

