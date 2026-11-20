import { now } from '../clock.js'
import type { Database } from '../db/database.js'
import type { Row } from '../db/rows.js'
import type { Worktrees } from '../repos/worktrees.js'

export type ProjectNote = { repo: string; body: string; updatedAt: string }
export type ProjectNoteSummary = { repo: string; updatedAt: string }

export const PROJECT_NOTE_LIMIT = 8000

export class ProjectNotes {
  constructor(
    private readonly database: Database,
    private readonly worktrees: Pick<Worktrees, 'repoOf'>,
  ) {}

  async read(repo: string): Promise<ProjectNote> {
    const root = await this.resolveRepo(repo)
    const row = this.database.prepare('SELECT repo_root, body, updated_at FROM project_notes WHERE repo_root = ?').get(root) as
      Row | undefined
    return row
      ? { repo: String(row.repo_root), body: String(row.body), updatedAt: String(row.updated_at) }
      : { repo: root, body: '', updatedAt: '' }
  }

  async update(repo: string, body: string): Promise<ProjectNote> {
    if (body.length > PROJECT_NOTE_LIMIT) {
      throw new Error(`body must be at most ${PROJECT_NOTE_LIMIT} characters`)
    }
    const root = await this.resolveRepo(repo)
    if (!body.trim()) {
      this.database.prepare('DELETE FROM project_notes WHERE repo_root = ?').run(root)
      return { repo: root, body: '', updatedAt: '' }
    }
    const updatedAt = now()
    this.database
      .prepare(
        `INSERT INTO project_notes (repo_root, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (repo_root) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(root, body, updatedAt)
    return { repo: root, body, updatedAt }
  }

  list(): ProjectNoteSummary[] {
    const rows = this.database
      .prepare('SELECT repo_root, updated_at FROM project_notes ORDER BY updated_at DESC, repo_root ASC')
      .all() as Row[]
    return rows.map(row => ({ repo: String(row.repo_root), updatedAt: String(row.updated_at) }))
  }

  private async resolveRepo(repo: string): Promise<string> {
    const resolved = await this.worktrees.repoOf(repo).catch(() => {
      throw new Error(`folder not found: ${repo}`)
    })
    if (!resolved) throw new Error(`${repo} is not inside a git repository`)
    return resolved.root
  }
}
