import { useState } from 'react'
import type { HealthState } from '../../../../shared/health'
import { healthStats } from '../../../../shared/health-math.mts'
import { Empty } from './ui'
import { displayDate, fmt, labels, nutrientKeys } from './format'
function Bars({ values, dates, label, unit }: { values: (number | null)[]; dates: string[]; label: string; unit: string }) {
  const maximum = Math.max(...values.map(value => value ?? 0), 1)
  return <div className="sp-chart"><div className="sp-bars" role="img" aria-label={`${label}: ${values.filter(value => value !== null).length} дней с данными. Точные значения в таблице ниже.`}>{values.map((value, index) => <div className="sp-bar-track" key={dates[index]} title={`${displayDate(dates[index])}: ${value === null ? 'Нет данных' : `${fmt(value)} ${unit}`}`}><span className={value === null ? 'is-missing' : ''} style={{ height: `${value === null ? 2 : Math.max(2, value / maximum * 100)}%` }} /></div>)}</div><div className="sp-chart-axis"><span>{displayDate(dates[0])}</span><span>{displayDate(dates.at(-1)!)}</span></div></div>
}
export default function ProgressView({ state, date }: { state: HealthState; date: string }) {
  const [days, setDays] = useState(30)
  const [exerciseId, setExerciseId] = useState('')
  const exercises = new Map(state.exercises.map(item => [item.id, item]))
  for (const workout of state.workouts) for (const entry of workout.entries) if (!exercises.has(entry.exerciseId)) exercises.set(entry.exerciseId, entry.exercise)
  const stats = healthStats(state, date, days, exerciseId)
  const hasData = stats.days.some(day => day.nutrition || day.workouts || day.wellbeing)
  return <div className="sp-stack"><div className="sp-section-title"><div><h2>Ваш прогресс</h2><p className="sp-hint">Период до {displayDate(date)} включительно</p></div><div className="sp-segments" aria-label="Период">{[7, 30, 90].map(n => <button key={n} aria-pressed={days === n} className={days === n ? 'is-active' : ''} onClick={() => setDays(n)}>{n} дней</button>)}</div></div>
    <div className="sp-stat-grid"><div className="sp-card"><span>Тренировок</span><strong>{stats.workoutCount}</strong></div><div className="sp-card"><span>Кардио</span><strong>{fmt(stats.cardioMinutes)} <small>мин</small></strong></div><div className="sp-card"><span>Расстояние</span><strong>{fmt(stats.distanceKm)} <small>км</small></strong></div></div>
    {!hasData && <Empty title="История начинается с первой записи">Добавьте тренировку, еду или отметку самочувствия — здесь появится динамика.</Empty>}
    <div className="sp-two-columns"><section className="sp-card"><h3>Калории по дням</h3><p className="sp-hint">Пропуск означает отсутствие записей, а не ноль калорий.</p><Bars label="Калории" values={stats.days.map(day => day.nutrition?.calories ?? null)} dates={stats.days.map(day => day.date)} unit="ккал" /></section><section className="sp-card"><h3>Самочувствие</h3><p className="sp-hint">Ваши отметки по шкале от 1 до 5.</p><Bars label="Самочувствие" values={stats.days.map(day => day.wellbeing)} dates={stats.days.map(day => day.date)} unit="из 5" /></section></div>
    <section className="sp-card"><div className="sp-section-title"><h3>По упражнению</h3><label className="sp-sr-only" htmlFor="sp-progress-exercise">Выберите упражнение</label><select id="sp-progress-exercise" value={exerciseId} onChange={e => setExerciseId(e.target.value)}><option value="">Выберите упражнение</option>{[...exercises.values()].map(exercise => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></div>
      {stats.exercisePoints.length ? <div className="sp-table-scroll"><table><thead><tr><th>Дата / вид</th><th>Подходы / повт.</th><th>Макс. вес, кг</th><th>Объём, кг</th><th>Время, мин</th><th>Км</th><th>Темп, мин/км</th></tr></thead><tbody>{stats.exercisePoints.map((point, index) => <tr key={`${point.date}-${index}`}><td>{displayDate(point.date)}<small className="sp-table-note">{{ weighted: 'С отягощением', bodyweight: 'Собственный вес', cardio: 'Кардио' }[point.mode]}</small></td><td>{point.sets ? `${point.sets} / ${point.reps}` : '—'}</td><td>{point.maxWeight === null ? '—' : fmt(point.maxWeight)}</td><td>{point.volume === null ? '—' : fmt(point.volume)}</td><td>{point.minutes ? fmt(point.minutes) : '—'}</td><td>{point.distanceKm === null ? '—' : fmt(point.distanceKm)}</td><td>{point.pace === null ? '—' : fmt(point.pace, 2)}</td></tr>)}</tbody></table></div> : <p className="sp-hint">{exerciseId ? 'За этот период нет записей упражнения.' : 'Сравнивайте записи одного упражнения или вида кардио.'}</p>}
      <p className="sp-hint">Объём — сумма веса × повторений. Для упражнений с собственным весом показываем подходы и повторения. Темп учитывает только кардио с известным расстоянием.</p>
    </section>
    <section className="sp-card"><h3>Дневник в цифрах</h3><div className="sp-table-scroll"><table><thead><tr><th>Дата</th>{nutrientKeys.map(key => <th key={key}>{labels[key]}{key === 'calories' ? ', ккал' : ', г'}</th>)}<th>Самочувствие</th></tr></thead><tbody>{[...stats.days].reverse().map(day => <tr key={day.date}><td>{displayDate(day.date)}</td>{nutrientKeys.map(key => <td key={key}>{day.nutrition ? fmt(day.nutrition[key]) : '—'}</td>)}<td>{day.wellbeing ? `${day.wellbeing} / 5` : '—'}</td></tr>)}</tbody></table></div></section>
  </div>
}
