import { useEffect, useState, type FormEvent } from 'react'
import type { MemoryState, TrendProfile, TrendReport, UserModuleContext } from '../../../../shared/trends'
import { getMemory, getModuleContexts, getProfile, loadHistory, saveProfile } from './api'

type Draft = { interests: string; goals: string; context: string; excludedTopics: string; experience: string; allowInterestQueries: boolean }
const toDraft = (profile: TrendProfile): Draft => ({ interests: profile.interests.join('\n'), goals: profile.goals.join('\n'), context: profile.context.join('\n'), excludedTopics: profile.excludedTopics.join('\n'), experience: profile.experience, allowInterestQueries: profile.allowInterestQueries })
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

export default function ResearchMemory({ revision, onLoad }: { revision: number; onLoad: (report: TrendReport) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [memory, setMemory] = useState<MemoryState | null>(null)
  const [modules, setModules] = useState<UserModuleContext[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getProfile(controller.signal).then((profile) => setDraft(toDraft(profile))).catch(() => {
      if (!controller.signal.aborted) setError('Профиль пока недоступен. Проверьте backend и откройте раздел снова.')
    })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    getModuleContexts(controller.signal).then(setModules).catch(() => undefined)
    getMemory(controller.signal).then(setMemory).catch(() => undefined)
    return () => controller.abort()
  }, [revision])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    setSaving(true); setError(''); setSaved('')
    try {
      const profile = await saveProfile({ interests: lines(draft.interests), goals: lines(draft.goals), context: lines(draft.context), excludedTopics: lines(draft.excludedTopics), experience: draft.experience, allowInterestQueries: draft.allowInterestQueries })
      setDraft(toDraft(profile)); setSaved('Профиль сохранён. Следующее исследование учтёт изменения.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить профиль') }
    finally { setSaving(false) }
  }
  async function open(id: string) {
    setOpening(id); setError('')
    try { onLoad(await loadHistory(id)) } catch { setError('Не удалось открыть исследование') }
    finally { setOpening(null) }
  }
  return (
    <div className="research-memory">
      <details className="context-panel">
        <summary><span>Профиль и релевантность</span><span className="mono">Локальная память</span></summary>
        {draft ? <form className="context-form" onSubmit={save}>
          <p className="form-caption">По одному пункту на строке. Профиль заполняете вы; личные файлы автоматически не читаются.</p>
          <div className="context-fields">
            <label>Интересы<textarea maxLength={4000} rows={3} value={draft.interests} onChange={(event) => setDraft({ ...draft, interests: event.target.value })} placeholder="Силовые тренировки
Базовый гардероб" /></label>
            <label>Цели<textarea maxLength={4000} rows={3} value={draft.goals} onChange={(event) => setDraft({ ...draft, goals: event.target.value })} placeholder="Что хотите улучшить или изучить" /></label>
            <label>Контекст и ограничения<textarea maxLength={4000} rows={3} value={draft.context} onChange={(event) => setDraft({ ...draft, context: event.target.value })} placeholder="Например, доступное оборудование или время" /></label>
            <label>Исключить темы<textarea maxLength={4000} rows={3} value={draft.excludedTopics} onChange={(event) => setDraft({ ...draft, excludedTopics: event.target.value })} placeholder="Темы, которые вам не подходят" /></label>
          </div>
          <label className="experience-field">Уровень опыта<input maxLength={300} value={draft.experience} onChange={(event) => setDraft({ ...draft, experience: event.target.value })} placeholder="Например, начинающий" /></label>
          <label className="ai-toggle"><input type="checkbox" checked={draft.allowInterestQueries} onChange={(event) => setDraft({ ...draft, allowInterestQueries: event.target.checked })} /><span>Разрешить использовать интересы как темы веб-поиска</span></label>
          <p className="form-caption">Цели и контекст не отправляются поисковику. Они доступны настроенной модели и локальному ранжированию.</p>
          <button className="secondary-button" type="submit" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить профиль'}</button>
          {saved ? <p className="form-caption" role="status">{saved}</p> : null}
        </form> : <p className="form-caption context-loading">Загрузка профиля…</p>}
      </details>
      <details className="context-panel">
        <summary><span>Контекст разделов</span><span className="mono">{modules.filter((item) => item.facts.length).length} подключено</span></summary>
        <div className="context-loading"><p className="form-caption">Сводки обновляются перед поиском, если включён учёт данных разделов. Фотографии и заметки гардероба не передаются. Остальные разделы подключаются по мере появления данных.</p>
          {modules.map((item) => <div key={item.module}><p>{item.module === 'wardrobe' ? 'Гардероб' : item.module} · {new Date(item.updatedAt).toLocaleString('ru-RU')}</p><p className="form-caption">{item.source}</p><ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>)}
        </div>
      </details>
      <details className="context-panel">
        <summary><span>Память исследований</span><span className="mono">{memory ? `${memory.runs.length} записей · ${memory.articleCount} публикаций` : 'Загрузка…'}</span></summary>
        <p className="form-caption context-loading">История учитывает прошлые находки; демо и живые данные разделены. Уже встречавшиеся источники отмечаются повторно.</p>
        {memory && !memory.runs.length ? <p className="form-caption context-loading">Пока нет исследований. Выполните первое с включённым сохранением.</p> : null}
        <ul className="memory-list">{memory?.runs.map((run) => <li key={run.id}><button type="button" disabled={opening !== null} onClick={() => open(run.id)}><span>{run.query || run.summary.slice(0, 100) || 'Обзор по области'}</span><span className="mono">{new Date(run.createdAt).toLocaleDateString('ru-RU')} · {run.mode === 'demo' ? 'демо' : 'живые'} · {run.articleCount + run.webCount} материалов{opening === run.id ? ' · открываем…' : ''}</span></button></li>)}</ul>
      </details>
      {error ? <p className="notice error-notice" role="alert">{error}</p> : null}
    </div>
  )
}
