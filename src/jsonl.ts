import { appendFile, readFile } from 'node:fs/promises'

/** Every parseable line of a JSON-lines log, oldest first. A missing log is empty. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // A line cut short by a crash mid-write; everything before it still counts.
    }
  }
  return out
}

/** Appends to a JSON-lines log one line at a time, in the order asked. */
export class JsonlAppender {
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async append(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`
    const write = this.writes.then(() => appendFile(this.path, line))
    // One failed write must not block every later one.
    this.writes = write.catch(() => undefined)
    await write
  }
}
