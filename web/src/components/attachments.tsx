import { File as FileIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { MessageAttachment } from '@contracts/attachments'
import { uploadPath } from '@/lib/api'
import { ghost } from '@/lib/styles'
import { cn } from '@/lib/utils'

const list = 'flex flex-wrap gap-1.5 text-xs'
const chip = 'flex max-w-full items-center gap-1.5 overflow-hidden rounded-md border bg-popover text-foreground'
const thumbnail = 'size-12 shrink-0 object-cover'

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${+(bytes / 1024).toFixed(1)} KB`
  return `${+(bytes / 1024 ** 2).toFixed(1)} MB`
}

function FileDetails({ name, size }: { name: string; size: number }) {
  return (
    <>
      <FileIcon className="ml-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 pr-1.5">
        <span className="block truncate" title={name}>
          {name}
        </span>
        <span className="block text-muted-foreground">{sizeLabel(size)}</span>
      </span>
    </>
  )
}

export function DraftAttachment({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [preview, setPreview] = useState<string>()
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The effect owns the lifetime of the object URL.
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <div className={chip}>
      {preview ? (
        <img className={thumbnail} src={preview} alt={file.name} title={file.name} />
      ) : (
        <FileDetails name={file.name} size={file.size} />
      )}
      <button
        className={cn(ghost, 'size-10 shrink-0 justify-center p-0 [&_svg]:size-4')}
        type="button"
        aria-label={`Remove ${file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </button>
    </div>
  )
}

export function MessageAttachments({ files }: { files: MessageAttachment[] }) {
  return (
    <div className={list}>
      {files.map((file, index) => {
        const url = uploadPath(file.id)
        return file.type.startsWith('image/') ? (
          <a
            key={`${file.id}-${index}`}
            className="block max-w-full overflow-hidden rounded-md"
            href={url}
            target="_blank"
            rel="noopener"
            title={`Open ${file.name}`}
          >
            <img className="h-24 w-32 max-w-full bg-popover object-contain" src={url} alt={file.name} />
          </a>
        ) : (
          <a key={`${file.id}-${index}`} className={cn(chip, 'min-h-10')} href={url} download={file.name}>
            <FileDetails name={file.name} size={file.size} />
          </a>
        )
      })}
    </div>
  )
}
