import { useEffect, useState } from 'react'
import { localDate } from './outfitDomain'

/** Refresh at local midnight and after returning from a sleeping browser tab. */
export function useLocalDate() {
  const [today, setToday] = useState(localDate)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function refresh() {
      setToday(localDate())
      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      clearTimeout(timer)
      timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 100)
    }
    function visible() { if (document.visibilityState === 'visible') refresh() }
    timer = setTimeout(refresh, 0)
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [])
  return today
}
