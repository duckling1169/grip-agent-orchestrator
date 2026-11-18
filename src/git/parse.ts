// Copied from duckling1169/agent-usage, hooks/lib/logic.ts (parseWorktreeList, parseStatusFiles,
// basename), so the two can change independently. parseWorktreeList here keeps the main checkout,
// which agent-usage drops.

export type WorktreeEntry = { path: string; folder: string; branch: string | null; head: string | null; main: boolean }

/** `git worktree list --porcelain`. The main checkout is always listed first. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain.split(/\r?\n\r?\n/).flatMap((block, index) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
    if (!path) return []
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? null
    return [{ path, folder: basename(path), branch, head, main: index === 0 }]
  })
}

/** File paths from `git status --porcelain`, renames reduced to their new name. */
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

/** A branch- and folder-safe slug from a run title: lowercase words joined by dashes. */
export function slugify(title: string, max = 40): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'run'
}
