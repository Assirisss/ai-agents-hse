import { useCallback } from 'react'

/** Bind each object URL to the image DOM lifetime, including React Activity cleanup. */
export default function PhotoImage({ blob, alt, lazy = false }: { blob: Blob; alt: string; lazy?: boolean }) {
  const bindImage = useCallback((image: HTMLImageElement | null) => {
    if (!image) return
    const url = URL.createObjectURL(blob)
    image.src = url
    return () => URL.revokeObjectURL(url)
  }, [blob])

  return <img ref={bindImage} alt={alt} loading={lazy ? 'lazy' : 'eager'} />
}
