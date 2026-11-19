export type FileChange = { name: string; added: number; removed: number }
export type PatchLine = { text: string; kind: 'add' | 'del' | 'hunk' | 'context' }

export function fileChanges(patch: string): FileChange[] {
  const files: FileChange[] = []
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (header) files.push({ name: header[1] as string, added: 0, removed: 0 })
    const current = files.at(-1)
    if (!current || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) current.added++
    else if (line.startsWith('-')) current.removed++
  }
  return files
}

export function patchLines(patch: string): PatchLine[] {
  return patch
    .split('\n')
    .filter(line => !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line))
    .map(line => ({
      text: line.startsWith('diff --git') ? line.replace(/^diff --git a\/.+ b\//, '@@ ') : line,
      kind:
        line.startsWith('diff --git') || line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : 'context',
    }))
}
