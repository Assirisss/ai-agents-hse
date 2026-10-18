import { useState, type FormEvent } from 'react'
import type { PlanningSettings } from '../../../../shared/planning'
import { planningApi } from './api'
import { errorText, usePlanning } from './context'

export default function SettingsView() {
  const { settings, capabilities, refresh } = usePlanning()
  const [value, setValue] = useState<PlanningSettings>(settings)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const set = (patch: Partial<PlanningSettings>) => setValue((current) => ({ ...current, ...patch }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(''); setError('')
    try {
      const { defaultCalendarId: _calendar, ...patch } = value
      await planningApi.saveSettings(patch)
      setMessage('Настройки сохранены')
      refresh()
    } catch (cause) { setError(errorText(cause)) }
  }

  const ai = capabilities?.ai
  return (
    <section className="pl-section" aria-labelledby="pl-settings-title">
      <h2 className="pl-section-title" id="pl-settings-title">Настройки</h2>
      <form className="pl-card pl-stack" style={{ marginTop: 16 }} onSubmit={submit}>
        <div className="pl-grid-2">
          <label className="pl-field">Часовой пояс
            <select value={value.timeZone} onChange={(event) => set({ timeZone: event.target.value })}>
              {(capabilities?.timeZones.length ? capabilities.timeZones : [value.timeZone]).map((zone) => <option key={zone}>{zone}</option>)}
            </select>
          </label>
          <label className="pl-field">Синхронизация календарей, каждые N минут<input type="number" min={1} max={1440} value={value.syncIntervalMinutes} onChange={(event) => set({ syncIntervalMinutes: Number(event.target.value) })} /></label>
        </div>
        <div className="pl-grid-4">
          <label className="pl-field">Утренний план в Telegram<input type="time" value={value.briefTime} disabled={!value.briefEnabled} onChange={(event) => set({ briefTime: event.target.value })} /></label>
          <label className="pl-check" style={{ alignSelf: 'end', minHeight: 36 }}><input type="checkbox" checked={value.briefEnabled} onChange={(event) => set({ briefEnabled: event.target.checked })} />Присылать план на день</label>
          <label className="pl-field">Напоминание о событии, мин<input type="number" min={0} max={1440} value={value.defaultReminderMinutes} onChange={(event) => set({ defaultReminderMinutes: Number(event.target.value) })} /></label>
          <label className="pl-field">О сроке задачи, мин<input type="number" min={0} max={10080} value={value.taskReminderMinutes} onChange={(event) => set({ taskReminderMinutes: Number(event.target.value) })} /></label>
        </div>
        <div className="pl-grid-4">
          <label className="pl-field">Рабочий день с<input type="time" value={value.workStart} onChange={(event) => set({ workStart: event.target.value })} /></label>
          <label className="pl-field">до<input type="time" value={value.workEnd} onChange={(event) => set({ workEnd: event.target.value })} /></label>
        </div>
        <p className="pl-caption">Рабочие часы используются для свободных окон и оценки перегрузки дня. Напоминания и план приходят в привязанные Telegram-чаты, пока запущен backend.</p>
        {error ? <p className="pl-notice error" role="alert">{error}</p> : null}
        {message ? <p className="pl-notice success" role="status">{message}</p> : null}
        <div className="pl-form-actions"><button type="submit" className="pl-button">Сохранить</button></div>
      </form>
      <div className="pl-card" style={{ marginTop: 16 }}>
        <h3>Модель для разбора текста</h3>
        {ai?.configured ? <p className="pl-muted" style={{ marginTop: 8 }}>Подключена: {ai.provider === 'ollama' ? 'локальная Ollama' : 'OpenRouter'}, <code className="pl-code">{ai.model}</code>. Модель вызывается только для сложных фраз — несколько дел в одном предложении, расплывчатые сроки — и лишь делит текст на дела. Даты всегда вычисляют правила.</p> : (
          <>
            <p className="pl-muted" style={{ marginTop: 8 }}>Сейчас работают только правила — они покрывают типичные фразы. Чтобы подключить локальную модель:</p>
            <ol className="pl-steps">
              <li>Установите <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Ollama</a> и скачайте модель: <code>ollama pull qwen3:8b</code></li>
              <li>В <code>backend/.env</code> укажите <code>PLANNING_LLM_MODEL=qwen3:8b</code> и перезапустите backend.</li>
            </ol>
          </>
        )}
      </div>
    </section>
  )
}
