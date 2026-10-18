import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import HealthPage from '../src/modules/health/HealthPage'
import '../src/index.css'
import '../src/App.css'

export function Preview() {
  const [width, setWidth] = useState(390)
  return <div style={{ padding: 24 }}><h1 style={{ fontSize: 20 }}>Проверка адаптивности</h1><p style={{ color: '#a1a1aa', margin: '10px 0' }}>Используется подключённый backend. Для тестовых записей запускайте отдельную базу.</p><div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>{[320, 390, 768, 1280].map(value => <button key={value} style={{ background: width === value ? '#0a84ff' : '#2c2c2e', padding: '8px 15px', borderRadius: 8 }} onClick={() => setWidth(value)}>{value} px</button>)}</div><iframe title="Спорт и питание" src="?embedded=1" width={width} height={820} style={{ border: '1px solid #3a3a3c', borderRadius: 12, maxWidth: '100%' }} /></div>
}
const embedded = new URLSearchParams(location.search).has('embedded')
const root = createRoot(document.getElementById('root')!)
root.render(embedded ? <main style={{ padding: '24px 16px' }}><HealthPage /></main> : <Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
