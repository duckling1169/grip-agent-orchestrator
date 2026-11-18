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
  size = 'default',
  children,
}: {
  noun: 'chat' | 'worker'
  title: string
  deleteDescription: string
  rename: (title: string) => Promise<void>
  remove: () => Promise<void>
  offline: boolean
  size?: 'default' | 'small'
  children: ReactNode
}) {
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const place = size === 'small' ? 'top-0.5' : 'top-2'
  return (
    <div className="group relative min-w-0">
      {children}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`absolute ${place} right-0 size-11 opacity-100 md:size-8 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 data-[state=open]:opacity-100`}
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
