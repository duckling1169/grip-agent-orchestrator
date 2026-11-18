import { ChevronRight, Folder } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

import { api, errorText } from '../api.js'
import { pathTrail } from '../paths.js'
import type { FolderListing } from '../types.js'
import { ErrorBanner, folderName } from './common.js'
import { ResponsiveDialog } from './responsive-dialog.js'

export function FolderPicker({
  start,
  recent,
  close,
  choose,
}: {
  start: string | null
  recent: string[]
  close: () => void
  choose: (path: string) => void
}) {
  const [at, setAt] = useState(start)
  const [response, setResponse] = useState<{ at: string | null; listing?: FolderListing; error?: string }>()
  const [filter, setFilter] = useState('')
  const trailRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void api.folders(at, controller.signal).then(
      listing => {
        if (!controller.signal.aborted) setResponse({ at, listing })
      },
      error => {
        if (controller.signal.aborted) return
        // A typed path may be incomplete. Keep the starting points available.
        if (at && at === start) setAt(null)
        else setResponse({ at, error: errorText(error) })
      },
    )
    return () => controller.abort()
  }, [at, start])

  const current = response?.at === at ? response : undefined
  const here = current?.listing?.path ?? null
  const trailPath = here ?? at
  const needle = filter.trim().toLowerCase()
  const folders = current?.listing?.folders.filter(folder => folder.name.toLowerCase().includes(needle)) ?? []
  const recentFolders = here ? [] : recent.slice(0, 5).filter(path => path.toLowerCase().includes(needle))

  useEffect(() => {
    const trail = trailRef.current
    if (trail) trail.scrollLeft = trail.scrollWidth
  }, [trailPath])

  function browse(path: string | null) {
    if (at === path) return
    setFilter('')
    setResponse(undefined)
    setAt(path)
  }

  return (
    <ResponsiveDialog
      title="Choose a folder"
      wide
      close={close}
      actions={
        <>
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button className="min-w-0" type="button" disabled={!here} onClick={() => here && choose(here)}>
            <span className="truncate">{here ? `Use ${folderName(here) || here}` : 'Use folder'}</span>
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-3">
        <nav className="min-w-0" aria-label="Folder path">
          <ol
            className="flex items-center gap-1 overflow-x-auto"
            ref={element => {
              // The dialog mounts after the effect runs, so show the current folder on mount too.
              trailRef.current = element
              if (element) element.scrollLeft = element.scrollWidth
            }}
          >
            <li className="shrink-0">
              <Button
                className="h-11 px-2 text-muted-foreground aria-[current=location]:text-foreground"
                size="sm"
                variant="ghost"
                type="button"
                aria-current={trailPath ? undefined : 'location'}
                onClick={() => browse(null)}
              >
                Start
              </Button>
            </li>
            {trailPath &&
              pathTrail(trailPath).map((part, index, parts) => (
                <li className="flex shrink-0 items-center gap-1" key={part.path}>
                  <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <Button
                    className="h-11 px-2 text-muted-foreground aria-[current=location]:text-foreground"
                    size="sm"
                    variant="ghost"
                    type="button"
                    aria-current={index === parts.length - 1 ? 'location' : undefined}
                    onClick={() => browse(part.path)}
                  >
                    {part.name}
                  </Button>
                </li>
              ))}
          </ol>
        </nav>
        <Input
          className="min-h-11 md:min-h-9"
          type="search"
          placeholder="Filter folders"
          aria-label="Filter folders by name"
          value={filter}
          onChange={event => setFilter(event.currentTarget.value)}
          onKeyDown={event => {
            // The portal is nested in the start form's React tree.
            if (event.key === 'Enter') event.preventDefault()
          }}
        />
        <ErrorBanner text={current?.error} />
        {!current && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading folders…
          </p>
        )}
        {current?.listing && (
          <ScrollArea className="min-w-0 rounded-md border [&_[data-slot=scroll-area-viewport]]:max-h-[min(21rem,40dvh)] [&_[data-slot=scroll-area-viewport]>div]:block!">
            <ul className="p-1">
              {recentFolders.length > 0 && <li className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Recent</li>}
              {recentFolders.map(path => (
                <li key={`recent-${path}`}>
                  <Button
                    className="h-auto min-h-11 w-full justify-start px-3 text-left font-normal"
                    variant="ghost"
                    type="button"
                    onClick={() => browse(path)}
                  >
                    <Folder aria-hidden="true" className="text-muted-foreground" />
                    <span className="grid min-w-0">
                      <span className="truncate">{folderName(path)}</span>
                      <span className="truncate text-xs text-muted-foreground" title={path}>
                        {path}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
              {!here && folders.length > 0 && <li className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Places</li>}
              {folders.map(folder => (
                <li key={folder.path}>
                  <Button
                    className="h-11 w-full justify-start px-3 text-left font-normal"
                    variant="ghost"
                    type="button"
                    onClick={() => browse(folder.path)}
                  >
                    <Folder aria-hidden="true" className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    {folder.repo && <Badge variant="secondary">git</Badge>}
                  </Button>
                </li>
              ))}
              {folders.length === 0 && recentFolders.length === 0 && (
                <li className="px-3 py-3 text-sm text-muted-foreground">{needle ? 'No folders match.' : 'No folders inside.'}</li>
              )}
            </ul>
          </ScrollArea>
        )}
      </div>
    </ResponsiveDialog>
  )
}
