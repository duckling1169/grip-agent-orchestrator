import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

import { cn } from '@/lib/utils'

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })), [text])
  return <div className={cn('prose-moxy break-words', className)} dangerouslySetInnerHTML={{ __html: html }} />
}
