/** Each folder from the drive or `/` down to `path`, for the picker's breadcrumbs. */
export function pathTrail(path: string): { name: string; path: string }[] {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
  const sep = windows ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const trail: { name: string; path: string }[] = []
  let at = windows ? '' : '/'
  if (!windows) trail.push({ name: '/', path: '/' })
  for (const [i, part] of parts.entries()) {
    at = windows ? (i === 0 ? `${part}${sep}` : `${at}${at.endsWith(sep) ? '' : sep}${part}`) : `${at}${at.endsWith('/') ? '' : '/'}${part}`
    trail.push({ name: part, path: at })
  }
  return trail
}
