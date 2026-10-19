import { Activity, useState } from 'react'
import Sidebar, { type SectionId } from './components/Sidebar'
import PlanningPage from './modules/planning/PlanningPage'
import FinancePage from './modules/finance/FinancePage'
import HealthPage from './modules/health/HealthPage'
import WardrobePage from './modules/wardrobe/WardrobePage'
import TrendsPage from './modules/trends/TrendsPage'
import './App.css'

const pages = [
  { id: 'planning', Page: PlanningPage },
  { id: 'finance', Page: FinancePage },
  { id: 'health', Page: HealthPage },
  { id: 'wardrobe', Page: WardrobePage },
  { id: 'trends', Page: TrendsPage },
] as const

export default function App() {
  const [active, setActive] = useState<SectionId>(() => ['default', 'demo'].includes(new URLSearchParams(window.location.search).get('financeProfile') || '') ? 'finance' : 'planning')

  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">К содержимому</a>
      <Sidebar active={active} onSelect={setActive} />
      <main className="content" id="main-content" tabIndex={-1}>
        {pages.map(({ id, Page }) => (
          <Activity key={id} mode={active === id ? 'visible' : 'hidden'}>
            <div className="screen"><Page /></div>
          </Activity>
        ))}
      </main>
    </div>
  )
}
