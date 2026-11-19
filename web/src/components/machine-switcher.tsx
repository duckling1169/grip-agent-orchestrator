import { ChevronDown, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Machine, MachineList } from '@contracts/machines'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { Connection } from '@/lib/live'
import { cn } from '@/lib/utils'

export function MachineSwitcher({ host, connection }: { host: string; connection: Connection }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<MachineList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  const load = async (refresh = false) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(null)
    try {
      const next = await api.machines(refresh, controller.signal)
      if (controller.signal.aborted) return
      setList(previous => (next.error && next.machines.every(machine => machine.self) && previous ? previous : next))
      setError(next.error)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Could not refresh machines. Reconnect to this machine and try again.')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const machineTip = connection === 'offline' ? `${host} is offline` : connection === 'reconnecting' ? `Reconnecting to ${host}` : host
  const current = list?.machines.find(machine => machine.self)

  return (
    <DropdownMenu
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) void load()
        else request.current?.abort()
      }}
    >
      <DropdownMenuTrigger asChild>
        <button className="ghost machine" type="button" title={machineTip} aria-label={`Switch machine: ${host}`}>
          {(connection === 'reconnecting' || connection === 'offline') && <span className={cn('dot', connection)} aria-hidden="true" />}
          <span>{host}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]" aria-label="Machines">
        <DropdownMenuLabel>Machines</DropdownMenuLabel>
        <DropdownMenuItem disabled>
          <span className="min-w-0 flex-1 truncate">{current?.name ?? host}</span>
          <span className="text-xs text-muted-foreground">Current</span>
        </DropdownMenuItem>
        {list?.machines
          .filter(machine => !machine.self)
          .map(machine => {
            const href = machineLink(machine)
            return href ? (
              <DropdownMenuItem key={machine.id} asChild>
                <a href={href} aria-label={`Open Moxy on ${machine.name}`}>
                  <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={machine.id} disabled>
                <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                <span className="text-xs text-muted-foreground">{machineStatus(machine)}</span>
              </DropdownMenuItem>
            )
          })}
        {loading && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
            Checking machines…
          </p>
        )}
        {error && (
          <div className="px-2 py-1.5 text-xs text-destructive" role="alert">
            {error}
            {list && ' Availability may be outdated or incomplete.'}
          </div>
        )}
        {list && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Checked{' '}
            <time dateTime={list.checkedAt}>{new Date(list.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={loading}
          onSelect={event => {
            event.preventDefault()
            void load(true)
          }}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden="true" />
          Refresh machines
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function machineLink(machine: Machine): string | null {
  if (machine.self || machine.moxy !== 'yes' || !machine.url) return null
  try {
    const target = new URL(machine.url)
    return target.protocol === 'https:' && !target.username && !target.password ? `${target.origin}/` : null
  } catch {
    return null
  }
}

function machineStatus(machine: Machine): string {
  if (!machine.online) return 'Tailnet offline'
  return machine.moxy === 'no' ? 'Moxy not detected' : 'Moxy status unknown'
}
