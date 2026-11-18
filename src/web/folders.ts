import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'

export type FolderEntry = { name: string; path: string; repo: boolean }

/** One folder's subfolders, for the app's folder picker. `path` null lists the starting points. */
export type FolderListing = { path: string | null; parent: string | null; folders: FolderEntry[] }

const MAX_ENTRIES = 1000

/**
 * Folder names on the principal, so a device can pick a folder instead of typing its path. Only
 * folder names are listed, never files. Hidden folders (`.name`) and Windows system folders
 * (`$name`) are left out.
 */
export async function listFolders(path: string | null, home: string = homedir()): Promise<FolderListing> {
  if (!path) {
    const roots = [{ name: 'Home', path: home }, ...driveRoots()]
    return { path: null, parent: null, folders: roots.map(r => ({ ...r, repo: isRepo(r.path) })) }
  }
  const folder = await realpath(path).catch(() => {
    throw new Error(`folder not found: ${path}`)
  })
  if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${path}`)
  const entries = await readdir(folder, { withFileTypes: true })
  const folders = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules')
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, MAX_ENTRIES)
    .map(name => ({ name, path: join(folder, name), repo: isRepo(join(folder, name)) }))
  const root = parse(folder).root === folder
  return { path: folder, parent: root ? null : dirname(folder), folders }
}

const isRepo = (path: string) => existsSync(join(path, '.git'))

/** Drive roots on Windows (`C:\`, `D:\`); none elsewhere, where Home and `/` cover it. */
function driveRoots(): { name: string; path: string }[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]
  const out = []
  for (let c = 67; c <= 90; c++) {
    const path = `${String.fromCharCode(c)}:\\`
    if (existsSync(path)) out.push({ name: path, path })
  }
  return out
}
