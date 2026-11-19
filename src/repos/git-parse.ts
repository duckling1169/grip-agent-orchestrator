// parseStatusFiles and basename are adapted from duckling1169/agent-usage, hooks/lib/logic.ts.

export function parseStatusFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
}

export function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || 'work'
}
