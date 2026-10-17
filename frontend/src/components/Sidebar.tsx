import type { ReactNode } from 'react'
import './Sidebar.css'

export type SectionId = 'planning' | 'finance' | 'health' | 'wardrobe' | 'trends'

const sections: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: 'planning', label: 'Дела и календарь', icon: <><rect x="4" y="6" width="16" height="15" rx="2" /><path d="M8 3v6m8-6v6M4 12h16m-11 4h2" /></> },
  { id: 'finance', label: 'Финансы', icon: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 9h18m-6 6h3" /></> },
  { id: 'health', label: 'Спорт и питание', icon: <><path d="m5 7 12 10M3 9l4-5m10 16 4-5M8 3l1 1M15 20l1 1M2 7l1 1m18 8 1 1" /></> },
  { id: 'wardrobe', label: 'Гардероб', icon: <><path d="m8 5-5 3 3 5 2-1v8h8v-8l2 1 3-5-5-3c0 4-8 4-8 0Z" /></> },
]

function Icon({ children }: { children: ReactNode }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
}

type Props = { active: SectionId; onSelect: (section: SectionId) => void }

export default function Sidebar({ active, onSelect }: Props) {
  function item(id: SectionId, label: string, icon: ReactNode) {
    return (
      <button
        key={id}
        type="button"
        className={`nav-item${active === id ? ' active' : ''}`}
        aria-current={active === id ? 'page' : undefined}
        onClick={() => onSelect(id)}
      >
        <Icon>{icon}</Icon><span>{label}</span>
      </button>
    )
  }

  return (
    <aside className="sidebar">
      <div className="lockup">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="m11 11 10 10" stroke="#636366" strokeWidth="1.5" />
          <circle cx="10" cy="10" r="3" fill="#f5f5f7" />
          <circle cx="22" cy="22" r="3" fill="#0a84ff" />
        </svg>
        <span className="wordmark">Личный ассистент</span>
      </div>
      <nav className="section-nav" aria-label="Разделы ассистента">
        {sections.map(({ id, label, icon }) => item(id, label, icon))}
      </nav>
      <div className="sidebar-divider" />
      <nav className="section-nav" aria-label="Общие инструменты">
        <p className="nav-caption">Инструменты</p>
        {item('trends', 'Поиск трендов', <><path d="M4 18 10 12l4 3 6-9m-6 0h6v6" /></>)}
      </nav>
      <div className="sidebar-footer"><span className="mono">Учебный проект</span><span className="mono">v0.2</span></div>
    </aside>
  )
}
