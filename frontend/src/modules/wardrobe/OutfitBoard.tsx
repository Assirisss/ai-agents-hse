import { useId, useMemo, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { Garment, OutfitLayer } from './types'
import { fitLayer } from './outfitDomain'
import PhotoImage from './PhotoImage'
import WardrobeIcon from './WardrobeIcon'

type Props = {
  layers: OutfitLayer[]
  garments: Garment[]
  selected?: string | null
  onSelect?: (id: string) => void
  onChange?: (layers: OutfitLayer[]) => void
  onInteractionStart?: () => void
  onInteractionEnd?: () => void
}

export default function OutfitBoard({ layers, garments, selected, onSelect, onChange, onInteractionStart, onInteractionEnd }: Props) {
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; pointerId: number; x: number; y: number; startX: number; startY: number; width: number; height: number } | null>(null)
  const catalog = useMemo(() => new Map(garments.map(item => [item.id, item])), [garments])
  const hintId = useId()

  function startDrag(event: PointerEvent<HTMLButtonElement>, layer: OutfitLayer) {
    if (event.button !== 0 || !event.isPrimary || !boardRef.current) return
    const bounds = boardRef.current.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    onSelect?.(layer.garmentId)
    onInteractionStart?.()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: layer.garmentId, pointerId: event.pointerId, x: layer.x, y: layer.y, startX: event.clientX, startY: event.clientY, width: bounds.width, height: bounds.height }
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const moving = drag.current
    if (!moving || event.pointerId !== moving.pointerId) return
    onChange?.(layers.map(layer => layer.garmentId === moving.id ? fitLayer({
      ...layer,
      x: moving.x + (event.clientX - moving.startX) / moving.width * 100,
      y: moving.y + (event.clientY - moving.startY) / moving.height * 100,
    }) : layer))
  }

  function moveWithKeys(event: KeyboardEvent<HTMLButtonElement>, layer: OutfitLayer) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const delta = moves[event.key]
    if (!delta) return
    event.preventDefault()
    const step = event.shiftKey ? 5 : 1
    onChange?.(layers.map(item => item.garmentId === layer.garmentId ? fitLayer({ ...item, x: item.x + delta[0] * step, y: item.y + delta[1] * step }) : item))
  }

  return (
    <div className="wd-board-wrap">
      <div className={`wd-board ${onChange ? 'wd-board-editable' : ''}`} ref={boardRef} role="group" aria-label="Коллаж образа">
        {layers.length === 0 ? <div className="wd-board-empty"><WardrobeIcon name="hanger" size={42} /><strong>Всё начинается с одной вещи</strong><span>Выберите вещи из коллекции рядом</span></div> : null}
        {layers.map((layer, index) => {
          const garment = catalog.get(layer.garmentId)
          const style = { left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.size}%`, height: `${layer.size}%`, zIndex: index + 1 }
          const content = garment ? <PhotoImage blob={garment.photo.display} alt={garment.name} /> : <span className="wd-missing-item"><WardrobeIcon name="hanger" /><span>Вещь удалена</span></span>
          return onChange ? (
            <button key={layer.garmentId} type="button" className={`wd-board-layer ${selected === layer.garmentId ? 'is-selected' : ''}`} style={style}
              aria-label={`${garment?.name ?? 'Удалённая вещь'} на доске`} aria-pressed={selected === layer.garmentId} aria-describedby={hintId}
              onClick={() => onSelect?.(layer.garmentId)} onFocus={() => onSelect?.(layer.garmentId)}
              onPointerDown={event => startDrag(event, layer)} onPointerMove={moveDrag}
              onPointerUp={() => { drag.current = null; onInteractionEnd?.() }} onPointerCancel={() => { drag.current = null; onInteractionEnd?.() }} onLostPointerCapture={() => { drag.current = null; onInteractionEnd?.() }}
              onKeyDown={event => moveWithKeys(event, layer)}>
              {content}
            </button>
          ) : <div key={layer.garmentId} className="wd-board-layer" style={style}>{content}</div>
        })}
      </div>
      {onChange ? <p className="wd-board-hint" id={hintId}>Перетаскивайте вещи мышью или пальцем. С клавиатуры — стрелки; Shift для большого шага.</p> : null}
    </div>
  )
}
