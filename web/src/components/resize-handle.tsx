import { useEffect, useRef, useState } from 'react'

import { useStoredState } from '../browser.js'

/** A column width you drag, kept per browser so the layout stays as you left it. */
export function useColumnWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)))
  const [width, setWidth] = useStoredState(`grip:width:${key}`, stored => (Number(stored) ? clamp(Number(stored)) : initial))
  return { width, setWidth: (value: number) => setWidth(clamp(value)), reset: () => setWidth(initial), min, max }
}

/**
 * The edge of a column you drag to resize it, like Claude Code's sidebar. `edge` is the side of
 * the column it sits on. Arrow keys move it too, and a double-click puts it back.
 */
export function ResizeHandle({
  column,
  edge,
  label,
}: {
  column: ReturnType<typeof useColumnWidth>
  edge: 'left' | 'right'
  label: string
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // A handle on the column's left edge grows the column as it moves left.
  const direction = edge === 'right' ? 1 : -1
  useEffect(() => {
    if (!dragging) return
    // Keep the resize cursor and stop text selection anywhere the pointer goes while dragging.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={column.width}
      aria-valuemin={column.min}
      aria-valuemax={column.max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={`group/handle absolute inset-y-0 z-10 hidden w-2 cursor-col-resize touch-none focus-visible:outline-none md:block ${edge === 'right' ? '-right-1' : '-left-1'}`}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width: column.width }
        setDragging(true)
      }}
      onPointerMove={event => {
        if (!drag.current) return
        column.setWidth(drag.current.width + (event.clientX - drag.current.x) * direction)
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={column.reset}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16
        if (event.key === 'ArrowLeft') column.setWidth(column.width - step * direction)
        else if (event.key === 'ArrowRight') column.setWidth(column.width + step * direction)
        else return
        event.preventDefault()
      }}
    >
      {/* A thin line that shows on hover, focus and while dragging. */}
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ring opacity-0 transition-opacity group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 ${dragging ? 'opacity-100' : ''}`}
        aria-hidden="true"
      />
    </div>
  )
}
