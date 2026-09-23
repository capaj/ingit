import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './image-lightbox.css'

export function ImageLightbox({ src, alt, onClose }: {
  src: string
  alt: string
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const zoom = useRef(1)
  const targetZoom = useRef(1)
  const frame = useRef(0)
  const [percent, setPercent] = useState(100)
  const [ready, setReady] = useState(false)

  function fitScale() {
    const view = viewport.current
    const img = image.current
    if (!view || !img?.naturalWidth) return 1
    return Math.min(1, (view.clientWidth - 48) / img.naturalWidth, (view.clientHeight - 48) / img.naturalHeight)
  }

  // Animate dimensions and scroll together so the image point under the cursor
  // stays anchored, including when the image grows beyond the viewport.
  function changeZoom(next: number, clientX?: number, clientY?: number, immediate = false) {
    const view = viewport.current
    const img = image.current
    if (!view || !img?.naturalWidth) return
    cancelAnimationFrame(frame.current)
    const bounds = view.getBoundingClientRect()
    const x = clientX === undefined ? view.clientWidth / 2 : clientX - bounds.left
    const y = clientY === undefined ? view.clientHeight / 2 : clientY - bounds.top
    const imageBounds = img.getBoundingClientRect()
    const anchorX = (bounds.left + x - imageBounds.left) / zoom.current
    const anchorY = (bounds.top + y - imageBounds.top) / zoom.current
    const from = zoom.current
    const to = Math.max(Math.min(0.1, fitScale()), Math.min(8, next))
    targetZoom.current = to
    const start = performance.now()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animate = (now: number) => {
      const progress = immediate || reducedMotion ? 1 : Math.min(1, (now - start) / 180)
      const scale = from + (to - from) * (1 - (1 - progress) ** 3)
      zoom.current = scale
      const width = img.naturalWidth * scale
      const height = img.naturalHeight * scale
      img.style.width = `${width}px`
      img.style.height = `${height}px`
      view.scrollLeft = Math.max(24, (view.clientWidth - width) / 2) + anchorX * scale - x
      view.scrollTop = Math.max(24, (view.clientHeight - height) / 2) + anchorY * scale - y
      setPercent(Math.round(scale * 100))
      if (progress < 1) frame.current = requestAnimationFrame(animate)
    }
    frame.current = requestAnimationFrame(animate)
  }

  useEffect(() => {
    const element = dialog.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      cancelAnimationFrame(frame.current)
      element.close()
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [])

  useEffect(() => {
    const view = viewport.current!
    const onWheel = (event: WheelEvent) => {
      // Ordinary scrolling pans; trackpad pinch / Ctrl+wheel zooms.
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1)
      changeZoom(targetZoom.current * Math.exp(-delta * 0.01), event.clientX, event.clientY)
    }
    view.addEventListener('wheel', onWheel, { passive: false })
    return () => view.removeEventListener('wheel', onWheel)
  }, [])

  return createPortal(
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-label={`Image preview: ${alt}`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          changeZoom(targetZoom.current * 1.25)
        } else if (event.key === '-') {
          event.preventDefault()
          changeZoom(targetZoom.current / 1.25)
        } else if (event.key === '0') {
          event.preventDefault()
          changeZoom(fitScale())
        }
      }}
    >
      <header className="image-lightbox-toolbar">
        <span className="image-lightbox-title" title={alt}>{alt}</span>
        <button type="button" disabled={!ready} aria-label="Zoom out" onClick={() => changeZoom(targetZoom.current / 1.25)}>−</button>
        <output aria-label="Zoom level">{percent}%</output>
        <button type="button" disabled={!ready} aria-label="Zoom in" onClick={() => changeZoom(targetZoom.current * 1.25)}>+</button>
        <button type="button" disabled={!ready} onClick={() => changeZoom(fitScale())}>Fit</button>
        <button type="button" disabled={!ready} onClick={() => changeZoom(1)}>100%</button>
        <button type="button" autoFocus aria-label="Close image preview" onClick={onClose}>✕</button>
      </header>
      <div className="image-lightbox-viewport" ref={viewport} tabIndex={0} aria-label="Scrollable image">
        <div className="image-lightbox-canvas">
          <img
            ref={image}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={() => { setReady(true); changeZoom(fitScale(), undefined, undefined, true) }}
            onDoubleClick={(event) => changeZoom(Math.abs(targetZoom.current - fitScale()) < 0.001 ? 1 : fitScale(), event.clientX, event.clientY)}
          />
        </div>
      </div>
      <footer className="image-lightbox-hint">Scroll to pan · Pinch or Ctrl + scroll to zoom · Double-click for actual size · Esc to close</footer>
    </dialog>,
    document.body,
  )
}
