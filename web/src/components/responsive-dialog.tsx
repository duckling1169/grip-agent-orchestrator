import { X } from 'lucide-react'
import { useRef, useSyncExternalStore, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'

const desktopQuery = '(min-width: 768px)'

function subscribeToDesktop(callback: () => void) {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

function isDesktop() {
  return window.matchMedia(desktopQuery).matches
}

export function ResponsiveDialog({
  title,
  close,
  busy = false,
  wide = false,
  actions,
  children,
}: {
  title: string
  close: () => void
  busy?: boolean
  wide?: boolean
  actions: ReactNode
  children: ReactNode
}) {
  const desktop = useSyncExternalStore(subscribeToDesktop, isDesktop)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const handleOpenChange = (open: boolean) => {
    if (!open && !busy) close()
  }
  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault()
    const active = document.activeElement
    if (!opener.current && active instanceof HTMLElement && active !== document.body && active !== titleRef.current) opener.current = active
    titleRef.current?.focus({ preventScroll: true })
  }
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault()
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
  }
  const body = <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6">{children}</div>
  const footer = 'flex flex-row flex-wrap justify-end gap-2 border-t px-4 pt-3 pb-4 *:min-h-11 sm:px-6 md:*:min-h-9'
  const contentProps = {
    'aria-describedby': undefined,
    onOpenAutoFocus,
    onCloseAutoFocus,
  }

  if (desktop) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent
          {...contentProps}
          showCloseButton={!busy}
          className={`flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
        >
          <DialogHeader className="shrink-0 px-6 py-4 pr-12 text-left">
            <DialogTitle ref={titleRef} tabIndex={-1} className="leading-6 outline-none">
              {title}
            </DialogTitle>
          </DialogHeader>
          {body}
          <DialogFooter className={footer}>{actions}</DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Sheet open onOpenChange={handleOpenChange}>
      <SheetContent {...contentProps} showCloseButton={false} side="bottom" className="flex max-h-dvh flex-col gap-0 rounded-t-lg p-0">
        <SheetHeader className="relative shrink-0 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pr-12 pb-3 text-left">
          <SheetTitle ref={titleRef} tabIndex={-1} className="leading-6 outline-none">
            {title}
          </SheetTitle>
          {!busy && (
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="absolute top-[calc(env(safe-area-inset-top,0px)+2px)] right-2 size-11"
                aria-label="Close dialog"
              >
                <X />
              </Button>
            </SheetClose>
          )}
        </SheetHeader>
        {body}
        <SheetFooter className={`${footer} pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]`}>{actions}</SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
