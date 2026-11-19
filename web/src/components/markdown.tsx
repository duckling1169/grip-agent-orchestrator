import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

import { cn } from '@/lib/utils'

const PROSE = cn(
  'break-words',
  '[&_:is(p,ul,ol,pre)]:mb-2 [&_:is(p,ul,ol,pre):last-child]:mb-0',
  '[&_:is(ul,ol)]:pl-5 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5',
  '[&_a]:underline [&_a]:underline-offset-2',
  '[&_code]:rounded [&_code]:bg-accent [&_code]:px-1.25 [&_code]:py-px [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:px-2.5 [&_pre]:py-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_:is(h1,h2,h3)]:mt-3 [&_:is(h1,h2,h3)]:mb-1 [&_:is(h1,h2,h3)]:font-semibold',
)

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })), [text])
  return <div className={cn(PROSE, className)} dangerouslySetInnerHTML={{ __html: html }} />
}
