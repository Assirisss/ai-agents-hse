type Props = { title: string; description: string }

export default function ModulePlaceholder({ title, description }: Props) {
  return (
    <>
      <p className="eyebrow">Рабочее пространство</p>
      <h1 className="screen-title">{title}</h1>
      <p className="module-description">{description}</p>
      <div className="module-empty">
        <h2 className="empty-heading">Пока ничего нет</h2>
        <p className="empty-copy">Здесь появятся ваши записи.</p>
      </div>
    </>
  )
}
