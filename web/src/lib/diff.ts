export type PatchLine = { text: string; kind: 'add' | 'del' | 'hunk' | 'context' }

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
