import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '../api.js'
import type { ChatSummary } from '../types.js'
import { ConfirmDialog } from './dialogs.js'

const REVEAL = 88
const LONG_PRESS_MS = 500

export function ChatRow({ chat, children, deleted }: { chat: ChatSummary; children: ReactNode; deleted: () => void }) {
  const [offset, setOffset] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const gesture = useRef<{ x: number; y: number; base: number; moved: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null)
  const suppressClick = useRef(false)
  useEffect(
    () => () => {
      if (gesture.current?.timer) clearTimeout(gesture.current.timer)
    },
    [],
  )
  const end = () => {
    if (gesture.current?.timer) clearTimeout(gesture.current.timer)
    gesture.current = null
    setSwiping(false)
    setOffset(current => (current < -REVEAL / 2 ? -REVEAL : 0))
  }
  return (
    <div className="group relative isolate overflow-hidden rounded-md">
      {(swiping || offset !== 0) && (
        <Button
          variant="destructive"
          className="absolute inset-y-0 right-0 h-full w-[88px] rounded-l-none"
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      )}
      <div
        className={`relative touch-pan-y bg-background ${swiping ? '' : 'transition-transform duration-150'}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={event => {
          if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button')) return
          const g: NonNullable<typeof gesture.current> = { x: event.clientX, y: event.clientY, base: offset, moved: false }
          g.timer = setTimeout(() => {
            if (!gesture.current?.moved) {
              suppressClick.current = true
              setConfirming(true)
              end()
            }
          }, LONG_PRESS_MS)
          gesture.current = g
        }}
        onPointerMove={event => {
          const g = gesture.current
          if (!g) return
          const dx = event.clientX - g.x,
            dy = event.clientY - g.y
          if (!g.moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return
          if (!g.moved) {
            g.moved = true
            if (g.timer) clearTimeout(g.timer)
            if (Math.abs(dy) > Math.abs(dx)) {
              gesture.current = null
              return
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            setSwiping(true)
          }
          setOffset(Math.max(-REVEAL, Math.min(0, g.base + dx)))
        }}
        onPointerUp={() => {
          if (gesture.current?.moved) suppressClick.current = true
          end()
        }}
        onPointerCancel={end}
        onClickCapture={event => {
          if (suppressClick.current || offset) {
            event.preventDefault()
            event.stopPropagation()
            suppressClick.current = false
            if (offset) setOffset(0)
          }
        }}
        onContextMenu={event => {
          event.preventDefault()
          setConfirming(true)
        }}
      >
        {children}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`absolute top-2 right-0 size-11 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 data-[state=open]:opacity-100 ${offset ? 'invisible' : ''}`}
            aria-label={`Chat actions for ${chat.title}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming && (
        <ConfirmDialog
          title="Delete chat?"
          description={`${chat.title} and its ${chat.runs.length} workers leave your list. Files stay on disk.`}
          label="Delete"
          busyLabel="Deleting…"
          offline={false}
          close={() => {
            setConfirming(false)
            setOffset(0)
          }}
          confirm={async () => {
            await api.deleteChat(chat.id)
            deleted()
          }}
        />
      )}
    </div>
  )
}
