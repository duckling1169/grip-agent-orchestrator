import { useEffect, useRef, useState } from 'react'

import { useStoredState } from '@/lib/stored'
import { cn } from '@/lib/utils'

export type ColumnWidth = ReturnType<typeof useColumnWidth>

export function useColumnWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)))
  const [width, setWidth] = useStoredState(`width:${key}`, stored => (Number(stored) ? clamp(Number(stored)) : initial))
  return { width, setWidth: (value: number) => setWidth(clamp(value)), min, max }
}

export function ResizeHandle({
  column,
  edge,
  label,
  onCollapse,
}: {
  column: ColumnWidth
  edge: 'left' | 'right'
  label: string
  onCollapse: () => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const direction = edge === 'right' ? 1 : -1
  useEffect(() => {
    if (!dragging) return
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])
  const end = () => {
    drag.current = null
    setDragging(false)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={column.width}
      aria-valuemin={column.min}
      aria-valuemax={column.max}
      tabIndex={0}
      title="Drag to resize. Double-click to hide."
      className={cn(
        'group/handle absolute max-md:hidden inset-y-0 z-10 w-2 cursor-col-resize touch-none focus-visible:outline-none',
        edge === 'right' ? '-right-1' : '-left-1',
      )}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width: column.width }
        setDragging(true)
      }}
      onPointerMove={event => {
        if (drag.current) column.setWidth(drag.current.width + (event.clientX - drag.current.x) * direction)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onCollapse}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16
        if (event.key === 'ArrowLeft') column.setWidth(column.width - step * direction)
        else if (event.key === 'ArrowRight') column.setWidth(column.width + step * direction)
        else return
        event.preventDefault()
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ring opacity-0 transition-opacity group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100',
          dragging && 'opacity-100',
        )}
      />
    </div>
  )
}
