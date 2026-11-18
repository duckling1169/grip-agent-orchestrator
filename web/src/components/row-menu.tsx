import { useState, type ReactNode } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ConfirmDialog, RenameDialog } from './dialogs.js'

/**
 * A chat or worker row with its `…` menu: Rename and Delete. Delete always asks first. The menu
 * is the only way in, so a stray right-click or swipe never deletes anything.
 */
export function RowMenu({
  noun,
  title,
  deleteDescription,
  rename,
  remove,
  offline,
  children,
}: {
  noun: 'chat' | 'worker'
  title: string
  deleteDescription: string
  rename: (title: string) => Promise<void>
  remove: () => Promise<void>
  offline: boolean
  children: ReactNode
}) {
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  return (
    <div className="group relative min-w-0">
      {children}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1/2 right-0 size-11 -translate-y-1/2 text-muted-foreground opacity-100 hover:bg-transparent hover:text-foreground focus-visible:text-foreground focus-visible:ring-0 data-[state=open]:text-foreground data-[state=open]:opacity-100 md:size-8 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 dark:hover:bg-transparent"
            aria-label={`Actions for ${noun} ${title}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={offline} onSelect={() => setDialog('rename')}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={offline} onSelect={() => setDialog('delete')}>
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'rename' && (
        <RenameDialog title={`Rename ${noun}`} current={title} offline={offline} close={() => setDialog(null)} rename={rename} />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${noun}?`}
          description={deleteDescription}
          label="Delete"
          busyLabel="Deleting…"
          offline={offline}
          close={() => setDialog(null)}
          confirm={remove}
        />
      )}
    </div>
  )
}
