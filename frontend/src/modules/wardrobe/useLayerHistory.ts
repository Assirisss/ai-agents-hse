import { useReducer, useRef } from 'react'
import type { OutfitLayer } from './types'

type State = { past: OutfitLayer[][]; present: OutfitLayer[]; future: OutfitLayer[][]; group?: string }
type Action = { type: 'set'; layers: OutfitLayer[]; group?: string } | { type: 'undo' | 'redo' }

function reducer(state: State, action: Action): State {
  if (action.type === 'undo') {
    const previous = state.past.at(-1)
    return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] } : state
  }
  if (action.type === 'redo') {
    const next = state.future[0]
    return next ? { past: [...state.past, state.present], present: next, future: state.future.slice(1) } : state
  }
  if (action.type !== 'set' || JSON.stringify(state.present) === JSON.stringify(action.layers)) return state
  const grouped = action.group !== undefined && action.group === state.group
  return { past: grouped ? state.past : [...state.past, state.present].slice(-50), present: action.layers.map(layer => ({ ...layer })), future: [], group: action.group }
}

/** A whole drag gesture is one undo step, rather than one step per pointer event. */
export function useLayerHistory(initial: OutfitLayer[]) {
  const [state, dispatch] = useReducer(reducer, initial, layers => ({ past: [], present: layers, future: [] }))
  const group = useRef<string | undefined>(undefined)
  return {
    layers: state.present,
    set: (layers: OutfitLayer[]) => dispatch({ type: 'set', layers, group: group.current }),
    begin: () => { group.current = crypto.randomUUID() },
    end: () => { group.current = undefined },
    undo: () => { group.current = undefined; dispatch({ type: 'undo' }) },
    redo: () => { group.current = undefined; dispatch({ type: 'redo' }) },
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}
