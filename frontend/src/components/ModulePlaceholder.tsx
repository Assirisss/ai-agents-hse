type ModulePlaceholderProps = {
  title: string
  description: string
}

export default function ModulePlaceholder({ title, description }: ModulePlaceholderProps) {
  return (
    <div className="module-placeholder">
      <h2>{title}</h2>
      <p className="module-description">{description}</p>
      <div className="empty-state">
        <span className="empty-state-mark" aria-hidden="true">＋</span>
        <h3>Пока пусто</h3>
        <p>Этот раздел скоро появится.</p>
      </div>
    </div>
  )
}
