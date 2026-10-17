import { useState, type KeyboardEvent } from 'react'
import PlanningPage from './modules/planning/PlanningPage'
import FinancePage from './modules/finance/FinancePage'
import HealthPage from './modules/health/HealthPage'
import WardrobePage from './modules/wardrobe/WardrobePage'
import './App.css'

const tabs = [
  { id: 'planning', label: 'Дела и календарь', Page: PlanningPage },
  { id: 'finance', label: 'Финансы', Page: FinancePage },
  { id: 'health', label: 'Спорт и питание', Page: HealthPage },
  { id: 'wardrobe', label: 'Гардероб', Page: WardrobePage },
] as const

type TabId = (typeof tabs)[number]['id']

function App() {
  const [activeTab, setActiveTab] = useState<TabId>(tabs[0].id)

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const nextTab = tabs[nextIndex]
    setActiveTab(nextTab.id)
    document.getElementById(`tab-${nextTab.id}`)?.focus()
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-mark" aria-hidden="true">ла</span>
        <div>
          <p className="app-eyebrow">Учебный проект · AI-агенты</p>
          <h1>Личный ассистент</h1>
        </div>
      </header>

      <main>
        <div className="tabs" role="tablist" aria-label="Разделы ассистента">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {tabs.map(({ id, Page }) => (
          <section
            key={id}
            id={`panel-${id}`}
            className="tab-panel"
            role="tabpanel"
            aria-labelledby={`tab-${id}`}
            hidden={activeTab !== id}
            tabIndex={0}
          >
            <Page />
          </section>
        ))}
      </main>
    </div>
  )
}

export default App
